import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { installMockFetch, restoreFetch, jsonResponse } from './helpers/mockFetch.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail } from '../src/repositories/users.js';
import { query } from '../src/db/pool.js';
import { runRadarNow } from '../src/jobs/dailyRadarJob.js';

// Fase 5 (núcleo): resumo/classificação de conversa (IA) e radar diário.
// Provider é sempre 'mock' nestes testes — nunca bate em API externa.

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-fase5@tractom.com.br';
let app;
let agent;
let tenantId;

before(async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'fake-token';
  delete process.env.ANTHROPIC_API_KEY; // garante provider mock mesmo que o .env real tenha a chave
  app = createApp();

  tenantId = await getDefaultTenantId();
  const existing = await findUserByEmail(tenantId, ADMIN_EMAIL);
  if (!existing) {
    await createUser(tenantId, { name: 'Admin Fase5', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
  }

  agent = request.agent(app);
  const loginRes = await agent.post('/api/auth/login').send({ email: ADMIN_EMAIL, password: 'senha-teste-123' });
  assert.equal(loginRes.status, 200);
});

beforeEach(async () => {
  await resetDb();
  await query('TRUNCATE TABLE ai_usage, conversation_insights, daily_radar_results RESTART IDENTITY CASCADE');
  await query(`UPDATE ai_settings SET provider = 'mock', monthly_limit = 1000 WHERE tenant_id = $1`, [tenantId]);
  restoreFetch();
});

after(async () => {
  restoreFetch();
  await closeDb();
});

function signPayload(body) {
  const raw = Buffer.from(JSON.stringify(body));
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
}

function inboundPayload({ waId, text = 'oi', msgId } = {}) {
  return { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name: 'Cliente Fase5' } }],
    messages: [{ id: msgId || 'wamid.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text } }],
  } }] }] };
}

async function createConversationViaWebhook(waId, text) {
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.auto.' + Math.random() }] }));
  const body = inboundPayload({ waId, text });
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 300));
  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === waId);
  const detail = await agent.get(`/api/contacts/${contact.id}`);
  return { conversationId: detail.body.conversations[0].id, contactId: contact.id };
}

test('resumo sob demanda: gera insight com provider mock e fica rastreável', async () => {
  const { conversationId } = await createConversationViaWebhook('5511400000001', 'Quero saber o preço do plano premium');

  const res = await agent.post(`/api/conversations/${conversationId}/summarize`);
  assert.equal(res.status, 200);
  assert.equal(res.body.generated_by, 'mock');
  assert.ok(res.body.summary);

  const latest = await agent.get(`/api/conversations/${conversationId}/insight`);
  assert.equal(latest.status, 200);
  assert.equal(latest.body.id, res.body.id);

  const usage = await query("SELECT * FROM ai_usage WHERE feature = 'summarize_conversation'");
  assert.equal(usage.rows.length, 1);
});

test('resumo automático acontece ao fechar a conversa', async () => {
  const { conversationId } = await createConversationViaWebhook('5511400000002', 'Preciso de ajuda com o pedido');

  await agent.patch(`/api/conversations/${conversationId}/status`).send({ status: 'closed' });
  await new Promise((r) => setTimeout(r, 300));

  const latest = await agent.get(`/api/conversations/${conversationId}/insight`);
  assert.equal(latest.status, 200);
  assert.ok(latest.body, 'deveria ter gerado um insight automaticamente ao fechar');
});

test('limite mensal de IA é respeitado (503 quando atinge o limite)', async () => {
  const { conversationId } = await createConversationViaWebhook('5511400000003', 'oi');
  await query('UPDATE ai_settings SET monthly_limit = 0 WHERE tenant_id = $1', [tenantId]);

  const res = await agent.post(`/api/conversations/${conversationId}/summarize`);
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'ai_unavailable');
});

test('configurações de IA: só admin acessa, atendente recebe 403', async () => {
  const email = `atendente-ia-${Date.now()}@tractom.com.br`;
  await createUser(tenantId, { name: 'Atendente IA', email, password: 'senha12345', role: 'atendente' });
  const atendenteAgent = request.agent(app);
  await atendenteAgent.post('/api/auth/login').send({ email, password: 'senha12345' });

  const forbidden = await atendenteAgent.get('/api/ai/settings');
  assert.equal(forbidden.status, 403);

  const allowed = await agent.get('/api/ai/settings');
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.provider, 'mock');

  const updated = await agent.put('/api/ai/settings').send({ monthly_limit: 50 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.monthly_limit, 50);
});

test('radar diário: gera resultado com prioridades e fica disponível via API', async () => {
  // Cria uma tarefa vencida pra garantir que o radar tem algo pra reportar.
  const { contactId } = await createConversationViaWebhook('5511400000004', 'oi');
  await agent.post('/api/tasks').send({ contact_id: contactId, title: 'Follow-up vencido', due_at: new Date(Date.now() - 86400000).toISOString() });

  const result = await runRadarNow(tenantId);
  assert.ok(result.id);
  assert.ok(Array.isArray(result.priorities));
  assert.ok(result.raw_data.tarefas_vencidas.length >= 1);

  const latest = await agent.get('/api/ai/radar/latest');
  assert.equal(latest.status, 200);
  assert.equal(latest.body.id, result.id);
});

test('rota POST /ai/radar/run roda sob demanda (admin/supervisor)', async () => {
  const res = await agent.post('/api/ai/radar/run');
  assert.equal(res.status, 201);
  assert.ok(Array.isArray(res.body.priorities));
});
