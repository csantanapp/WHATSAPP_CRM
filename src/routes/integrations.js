import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import {
  getOAuthClient, saveOAuthClient, newOAuthState, buildAuthUrl, completeConnection, getConnection, disconnect,
  addSheet, listSheets, getSheet, removeSheet, getSpreadsheetMeta, getHeaders, getNewContactsSync, setNewContactsSync,
} from '../integrations/google.js';
import { listAiConnections, saveAiProviderKey, deleteAiProviderKey, setDefaultAiProvider, testAiProvider } from '../services/ai/AIService.js';
import { logger } from '../logger.js';

// Tela "Integrações": Google Sheets (Conectar conta Google) e IA (ChatGPT,
// Claude...). Ver/usar: qualquer usuário logado; conectar/alterar: admin.
export const integrationsRouter = Router();

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch((err) => {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  });
}

// Endereço de retorno do Google: o domínio que o usuário está usando (atrás do
// Caddy, o Express confia no X-Forwarded-Proto) ou PUBLIC_URL, se definido.
function redirectUriFor(req) {
  const base = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
  return `${base}/api/integrations/google/callback`;
}

integrationsRouter.get('/', asyncHandler(async (req, res) => {
  const client = await getOAuthClient();
  const connection = await getConnection(req.tenantId);
  res.json({
    google: {
      client_configured: Boolean(client),
      client_source: client?.source || null,
      client_id: client?.clientId || null,
      redirect_uri: redirectUriFor(req),
      connected: Boolean(connection),
      email: connection?.email || null,
      connected_at: connection?.connected_at || null,
      sheets: await listSheets(req.tenantId),
      new_contacts: await getNewContactsSync(),
    },
    ai: await listAiConnections(req.tenantId),
  });
}));

// ── Google ──

integrationsRouter.put('/google/client', requireRole('admin'), asyncHandler(async (req, res) => {
  await saveOAuthClient({ clientId: req.body.client_id, clientSecret: req.body.client_secret });
  res.status(204).end();
}));

integrationsRouter.post('/google/connect', requireRole('admin'), asyncHandler(async (req, res) => {
  const state = newOAuthState();
  const redirectUri = redirectUriFor(req);
  req.session.googleOAuth = { state, redirectUri };
  res.json({ url: await buildAuthUrl({ redirectUri, state }) });
}));

// O Google volta pra cá no navegador (sessão por cookie). Depois de salvar,
// manda o usuário de volta pra tela Integrações com o resultado na URL.
integrationsRouter.get('/google/callback', async (req, res) => {
  const pending = req.session.googleOAuth;
  delete req.session.googleOAuth;
  const back = (status, msg) => res.redirect('/?integracao=' + status + (msg ? '&msg=' + encodeURIComponent(msg) : ''));
  if (req.query.error) return back('google_erro', req.query.error === 'access_denied' ? 'Você cancelou a autorização no Google.' : String(req.query.error));
  if (!pending || !req.query.state || req.query.state !== pending.state) return back('google_erro', 'A autorização expirou. Clique em “Conectar conta Google” de novo.');
  try {
    const { email } = await completeConnection({ tenantId: req.tenantId, code: String(req.query.code || ''), redirectUri: pending.redirectUri, userId: req.user.id });
    return back('google_ok', email || '');
  } catch (err) {
    logger.error('google_oauth_callback_failed', { message: err.message });
    return back('google_erro', err.message);
  }
});

integrationsRouter.delete('/google', requireRole('admin'), asyncHandler(async (req, res) => {
  await disconnect(req.tenantId);
  res.status(204).end();
}));

integrationsRouter.post('/google/sheets', requireRole('admin'), asyncHandler(async (req, res) => {
  res.status(201).json(await addSheet(req.tenantId, req.body.url));
}));

integrationsRouter.delete('/google/sheets/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  await removeSheet(req.tenantId, req.params.id);
  res.status(204).end();
}));

integrationsRouter.get('/google/sheets/:id/tabs', asyncHandler(async (req, res) => {
  const sheet = await getSheet(req.tenantId, req.params.id);
  if (!sheet) return res.status(404).json({ error: 'Planilha não encontrada' });
  res.json((await getSpreadsheetMeta(req.tenantId, sheet.spreadsheet_id)).tabs);
}));

integrationsRouter.get('/google/sheets/:id/headers', asyncHandler(async (req, res) => {
  const sheet = await getSheet(req.tenantId, req.params.id);
  if (!sheet) return res.status(404).json({ error: 'Planilha não encontrada' });
  if (!req.query.tab) return res.status(400).json({ error: 'Informe a aba' });
  res.json(await getHeaders(req.tenantId, sheet.spreadsheet_id, String(req.query.tab)));
}));

integrationsRouter.put('/google/new-contacts', requireRole('admin'), asyncHandler(async (req, res) => {
  res.json(await setNewContactsSync({ enabled: req.body.enabled, sheetId: req.body.sheet_id, tab: req.body.tab }));
}));

// ── IA (ChatGPT, Claude...) ──

integrationsRouter.put('/ai/:provider', requireRole('admin'), asyncHandler(async (req, res) => {
  await saveAiProviderKey(req.tenantId, req.params.provider, { apiKey: req.body.api_key, model: req.body.model });
  res.json(await listAiConnections(req.tenantId));
}));

integrationsRouter.post('/ai/:provider/test', requireRole('admin'), asyncHandler(async (req, res) => {
  res.json(await testAiProvider(req.tenantId, req.params.provider));
}));

integrationsRouter.post('/ai/:provider/default', requireRole('admin'), asyncHandler(async (req, res) => {
  await setDefaultAiProvider(req.tenantId, req.params.provider);
  res.json(await listAiConnections(req.tenantId));
}));

integrationsRouter.delete('/ai/:provider', requireRole('admin'), asyncHandler(async (req, res) => {
  await deleteAiProviderKey(req.tenantId, req.params.provider);
  res.json(await listAiConnections(req.tenantId));
}));
