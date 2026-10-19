import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { getSetting, setSetting } from '../repositories/settings.js';
import { encryptSecret, decryptSecret } from '../services/crypto.js';
import { logger } from '../logger.js';

// Integração Google Sheets via "Conectar conta Google" (OAuth 2.0), com
// chamadas HTTP diretas (sem SDK). O Client ID/Secret do projeto no Google
// Cloud é colado uma vez na tela Integrações (ou vem do .env); o refresh token
// da conta conectada fica criptografado no banco e renova o acesso sozinho.

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

// app_settings guarda texto: objetos vão como JSON.
async function getJsonSetting(key) {
  const raw = await getSetting(key);
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}
const setJsonSetting = (key, value) => setSetting(key, JSON.stringify(value));

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// ── Credenciais do app (Client ID/Secret) ──

export async function getOAuthClient() {
  const saved = await getJsonSetting('google_oauth_client');
  if (saved?.client_id && saved?.client_secret_encrypted) {
    try {
      return { clientId: saved.client_id, clientSecret: decryptSecret(saved.client_secret_encrypted), source: 'panel' };
    } catch (err) {
      logger.error('google_client_decrypt_failed', { message: err.message });
    }
  }
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, source: 'env' };
  }
  return null;
}

export async function saveOAuthClient({ clientId, clientSecret }) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!/\.apps\.googleusercontent\.com$/.test(id)) throw httpError('O Client ID do Google termina com ".apps.googleusercontent.com".');
  if (secret.length < 10) throw httpError('Cole o Client Secret do Google.');
  await setJsonSetting('google_oauth_client', { client_id: id, client_secret_encrypted: encryptSecret(secret) });
}

// ── Conectar a conta ──

export function newOAuthState() {
  return crypto.randomBytes(24).toString('hex');
}

export async function buildAuthUrl({ redirectUri, state }) {
  const client = await getOAuthClient();
  if (!client) throw httpError('Configure o Client ID e o Client Secret do Google antes de conectar.');
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // garante o refresh token mesmo se a conta já autorizou antes
    include_granted_scopes: 'true',
    state,
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

async function tokenRequest(body) {
  const client = await getOAuthClient();
  if (!client) throw httpError('Integração com o Google não configurada.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...body }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(data.error_description || data.error || `Google recusou o acesso (${res.status})`, 502);
  return data;
}

export async function completeConnection({ tenantId, code, redirectUri, userId }) {
  const tokens = await tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  // O Google mostra as permissões como caixinhas que podem vir desmarcadas:
  // sem a de planilhas, a conexão não serve pra nada — avisa na hora.
  if (tokens.scope && !String(tokens.scope).split(' ').includes('https://www.googleapis.com/auth/spreadsheets')) {
    throw httpError('Faltou permitir o acesso às planilhas. Conecte de novo e, na tela do Google, marque a caixa “Ver, editar, criar e excluir todas as suas planilhas”.', 400);
  }
  if (!tokens.refresh_token) throw httpError('O Google não devolveu acesso permanente. Tente conectar de novo.', 502);
  let email = null;
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
    if (res.ok) email = (await res.json()).email || null;
  } catch (err) {
    logger.info('google_userinfo_failed', { message: err.message });
  }
  await query(
    `INSERT INTO google_connections (tenant_id, email, refresh_token_encrypted, access_token_encrypted, access_token_expires_at, connected_by)
     VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5), $6)
     ON CONFLICT (tenant_id) DO UPDATE SET email = EXCLUDED.email, refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
       access_token_encrypted = EXCLUDED.access_token_encrypted, access_token_expires_at = EXCLUDED.access_token_expires_at,
       connected_by = EXCLUDED.connected_by, connected_at = now()`,
    [tenantId, email, encryptSecret(tokens.refresh_token), encryptSecret(tokens.access_token), Math.max(60, (tokens.expires_in || 3600) - 60), userId || null]
  );
  return { email };
}

export async function getConnection(tenantId) {
  return (await query('SELECT email, connected_at FROM google_connections WHERE tenant_id = $1', [tenantId])).rows[0] || null;
}

export async function disconnect(tenantId) {
  const row = (await query('SELECT refresh_token_encrypted FROM google_connections WHERE tenant_id = $1', [tenantId])).rows[0];
  if (row) {
    try {
      await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(decryptSecret(row.refresh_token_encrypted)), { method: 'POST' });
    } catch (err) {
      logger.info('google_revoke_failed', { message: err.message });
    }
  }
  await query('DELETE FROM google_connections WHERE tenant_id = $1', [tenantId]);
}

// Token de acesso válido, renovando com o refresh token quando expirou.
async function getAccessToken(tenantId) {
  const row = (await query('SELECT * FROM google_connections WHERE tenant_id = $1', [tenantId])).rows[0];
  if (!row) throw httpError('Conta Google não conectada. Conecte em Integrações.', 409);
  let refreshToken;
  try {
    if (row.access_token_encrypted && row.access_token_expires_at && new Date(row.access_token_expires_at) > new Date()) {
      return decryptSecret(row.access_token_encrypted);
    }
    refreshToken = decryptSecret(row.refresh_token_encrypted);
  } catch (err) {
    logger.error('google_token_decrypt_failed', { message: err.message });
    throw httpError('O acesso à conta Google precisa ser refeito. Em Integrações, desconecte e conecte a conta de novo.', 409);
  }
  const tokens = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  await query(
    `UPDATE google_connections SET access_token_encrypted = $2, access_token_expires_at = now() + make_interval(secs => $3) WHERE tenant_id = $1`,
    [tenantId, encryptSecret(tokens.access_token), Math.max(60, (tokens.expires_in || 3600) - 60)]
  );
  return tokens.access_token;
}

async function sheetsFetch(tenantId, url, options = {}) {
  const token = await getAccessToken(tenantId);
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Google Sheets respondeu ${res.status}`;
    const reason = data?.error?.details?.find((d) => d.reason)?.reason;
    if (reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
      throw httpError('A conta Google foi conectada sem a permissão de planilhas. Clique em Desconectar, conecte de novo e marque a caixa “Ver, editar, criar e excluir todas as suas planilhas”.', 502);
    }
    if (reason === 'SERVICE_DISABLED') {
      throw httpError('A Google Sheets API não está ativada no projeto do Google Cloud. Ative em console.cloud.google.com → APIs e serviços → Biblioteca → Google Sheets API.', 502);
    }
    logger.info('google_sheets_error', { status: res.status, reason, message: msg });
    if (res.status === 403 || res.status === 404) throw httpError('Sem acesso a essa planilha com a conta conectada. Confira o link e se a conta tem permissão de edição.', 502);
    throw httpError(msg, 502);
  }
  return data;
}

// ── Planilhas ──

export function parseSpreadsheetId(input) {
  const text = String(input || '').trim();
  const fromUrl = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (fromUrl) return fromUrl[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) return text;
  return null;
}

export async function getSpreadsheetMeta(tenantId, spreadsheetId) {
  const data = await sheetsFetch(tenantId, `${SHEETS}/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties.title`);
  return { title: data.properties?.title || 'Planilha', tabs: (data.sheets || []).map((s) => s.properties.title) };
}

export async function addSheet(tenantId, urlOrId) {
  const spreadsheetId = parseSpreadsheetId(urlOrId);
  if (!spreadsheetId) throw httpError('Cole o link da planilha do Google Sheets (docs.google.com/spreadsheets/d/...).');
  const meta = await getSpreadsheetMeta(tenantId, spreadsheetId);
  const result = await query(
    `INSERT INTO google_sheets (tenant_id, spreadsheet_id, title) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, spreadsheet_id) DO UPDATE SET title = EXCLUDED.title RETURNING *`,
    [tenantId, spreadsheetId, meta.title]
  );
  return { ...result.rows[0], tabs: meta.tabs };
}

export async function listSheets(tenantId) {
  return (await query('SELECT * FROM google_sheets WHERE tenant_id = $1 ORDER BY created_at', [tenantId])).rows;
}

export async function getSheet(tenantId, id) {
  return (await query('SELECT * FROM google_sheets WHERE tenant_id = $1 AND id = $2', [tenantId, id])).rows[0] || null;
}

export async function removeSheet(tenantId, id) {
  await query('DELETE FROM google_sheets WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
}

// Intervalo A1 de uma aba (nome entre aspas simples; aspas dobradas dentro).
function rangeOf(tab, cells = 'A1:ZZ') {
  return `'${String(tab).replace(/'/g, "''")}'!${cells}`;
}

function columnLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const norm = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

async function readTab(tenantId, spreadsheetId, tab) {
  const data = await sheetsFetch(tenantId, `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(rangeOf(tab))}`);
  const rows = data.values || [];
  return { headers: (rows[0] || []).map((h) => String(h).trim()), rows: rows.slice(1) };
}

export async function getHeaders(tenantId, spreadsheetId, tab) {
  return (await readTab(tenantId, spreadsheetId, tab)).headers.filter(Boolean);
}

// Procura a primeira linha em que a coluna `column` (pelo cabeçalho) tem o
// valor `value` (sem diferenciar maiúscula/acento; telefone compara só dígitos).
export async function findRow(tenantId, spreadsheetId, tab, column, value) {
  const { headers, rows } = await readTab(tenantId, spreadsheetId, tab);
  const col = headers.findIndex((h) => norm(h) === norm(column));
  if (col === -1) return null;
  const target = norm(value);
  const digits = String(value ?? '').replace(/\D/g, '');
  const isPhoneLike = digits.length >= 8 && digits.length >= target.replace(/[\s()+-]/g, '').length - 1;
  const idx = rows.findIndex((r) => {
    const cell = r[col];
    if (cell == null || cell === '') return false;
    if (norm(cell) === target) return true;
    if (isPhoneLike) {
      const cd = String(cell).replace(/\D/g, '');
      return cd.length >= 8 && (cd === digits || cd.endsWith(digits) || digits.endsWith(cd));
    }
    return false;
  });
  if (idx === -1) return null;
  const record = {};
  headers.forEach((h, i) => { if (h) record[h] = rows[idx][i] ?? ''; });
  return { rowNumber: idx + 2, record };
}

// Grava `record` ({ Cabeçalho: valor }) na aba: cria os cabeçalhos que não
// existem; com `matchColumn`, atualiza a linha em que essa coluna já tem o
// mesmo valor (sem duplicar o lead), senão adiciona uma linha nova no fim.
export async function saveRecord(tenantId, spreadsheetId, tab, record, { matchColumn = null } = {}) {
  const entries = Object.entries(record).filter(([h]) => String(h).trim());
  if (!entries.length) return { action: 'skipped' };
  const { headers, rows } = await readTab(tenantId, spreadsheetId, tab);
  const allHeaders = [...headers];
  for (const [h] of entries) {
    if (!allHeaders.some((x) => norm(x) === norm(h))) allHeaders.push(String(h).trim());
  }
  if (allHeaders.length !== headers.length) {
    await sheetsFetch(tenantId, `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(rangeOf(tab, 'A1'))}?valueInputOption=USER_ENTERED`, {
      method: 'PUT', body: JSON.stringify({ values: [allHeaders] }),
    });
  }
  const colOf = (h) => allHeaders.findIndex((x) => norm(x) === norm(h));

  let rowNumber = null;
  let existing = [];
  if (matchColumn) {
    const mc = colOf(matchColumn);
    const matchValue = entries.find(([h]) => norm(h) === norm(matchColumn))?.[1];
    if (mc !== -1 && matchValue) {
      const digits = String(matchValue).replace(/\D/g, '');
      const idx = rows.findIndex((r) => {
        const cell = String(r[mc] ?? '');
        if (!cell) return false;
        if (norm(cell) === norm(matchValue)) return true;
        return digits.length >= 8 && cell.replace(/\D/g, '') === digits;
      });
      if (idx !== -1) { rowNumber = idx + 2; existing = rows[idx]; }
    }
  }

  const values = allHeaders.map((h, i) => {
    const hit = entries.find(([k]) => norm(k) === norm(h));
    return hit ? String(hit[1] ?? '') : (existing[i] ?? '');
  });

  if (rowNumber) {
    const range = rangeOf(tab, `A${rowNumber}:${columnLetter(allHeaders.length - 1)}${rowNumber}`);
    await sheetsFetch(tenantId, `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT', body: JSON.stringify({ values: [values] }),
    });
    return { action: 'updated', rowNumber };
  }
  await sheetsFetch(tenantId, `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(rangeOf(tab, 'A1'))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST', body: JSON.stringify({ values: [values] }),
  });
  return { action: 'appended' };
}

// ── "Enviar todo contato novo" ──

export async function getNewContactsSync() {
  return (await getJsonSetting('google_sheets_new_contacts')) || { enabled: false, sheet_id: null, tab: null };
}

export async function setNewContactsSync({ enabled, sheetId, tab }) {
  const value = { enabled: Boolean(enabled), sheet_id: sheetId ? Number(sheetId) : null, tab: tab || null };
  if (value.enabled && (!value.sheet_id || !value.tab)) throw httpError('Escolha a planilha e a aba para enviar os contatos novos.');
  await setJsonSetting('google_sheets_new_contacts', value);
  return value;
}
