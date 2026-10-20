import { query } from '../db/pool.js';
import { getSetting, setSetting } from '../repositories/settings.js';
import { encryptSecret, decryptSecret } from '../services/crypto.js';
import { notify } from '../repositories/notifications.js';
import { logger } from '../logger.js';

// Token da conta do Instagram ("Instagram API com login do Instagram").
// O token de longa duração vence em 60 dias: renovamos toda semana e
// guardamos o novo (criptografado) no banco. Sem token salvo, usa o do .env
// (INSTAGRAM_PAGE_ACCESS_TOKEN), que é o ponto de partida de cada instalação.

const KEY = 'instagram_token';
const REFRESH_EVERY_MS = 7 * 24 * 3600 * 1000;
const ALERT_EVERY_MS = 24 * 3600 * 1000;

async function readStored() {
  const raw = await getSetting(KEY);
  if (!raw) return null;
  try { return typeof raw === 'object' ? raw : JSON.parse(raw); } catch { return null; }
}

export async function getInstagramToken() {
  const stored = await readStored();
  if (stored?.encrypted) {
    try {
      return decryptSecret(stored.encrypted);
    } catch (err) {
      logger.error('instagram_token_decrypt_failed', { message: err.message });
    }
  }
  return process.env.INSTAGRAM_PAGE_ACCESS_TOKEN || null;
}

async function alertAdmins(message) {
  const stored = (await readStored()) || {};
  if (stored.last_alert_at && Date.now() - new Date(stored.last_alert_at).getTime() < ALERT_EVERY_MS) return;
  const admins = (await query(`SELECT id FROM users WHERE role = 'admin' AND status = 'active'`)).rows.map((r) => r.id);
  await notify({ to: admins, type: 'task', title: 'Instagram: renove a conexão', body: message });
  await setSetting(KEY, JSON.stringify({ ...stored, last_alert_at: new Date().toISOString() }));
}

// Renova se o último refresh tem mais de 7 dias (ou `force`). Nunca lança erro.
export async function refreshInstagramTokenIfNeeded({ force = false } = {}) {
  const token = await getInstagramToken();
  if (!token) return { skipped: 'sem_token' };
  const stored = (await readStored()) || {};
  if (!force && stored.refreshed_at && Date.now() - new Date(stored.refreshed_at).getTime() < REFRESH_EVERY_MS) {
    return { skipped: 'recente' };
  }
  try {
    const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(data?.error?.message || `Instagram respondeu ${res.status}`);
    const expiresAt = new Date(Date.now() + (Number(data.expires_in) || 60 * 24 * 3600) * 1000).toISOString();
    await setSetting(KEY, JSON.stringify({ encrypted: encryptSecret(data.access_token), refreshed_at: new Date().toISOString(), expires_at: expiresAt }));
    logger.info('instagram_token_refreshed', { expiresAt });
    return { refreshed: true, expiresAt };
  } catch (err) {
    logger.error('instagram_token_refresh_failed', { message: err.message });
    await alertAdmins('Não foi possível renovar o acesso ao Instagram (' + err.message + '). Gere um novo token no app da Meta, senão as mensagens do Instagram param de chegar.').catch(() => {});
    return { error: err.message };
  }
}
