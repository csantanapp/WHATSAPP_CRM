import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { installMockFetch, restoreFetch, jsonResponse } from './helpers/mockFetch.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail } from '../src/repositories/users.js';

// Fase 3 (núcleo): origem/atribuição, oportunidades, follow-up/tarefas.

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-fase3@tractom.com.br';
let app;
let agent;
let tenantId;

before(async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'fake-token';
  app = createApp();

  tenantId = await getDefaultTenantId();
  const existing = await findUserByEmail(tenantId, ADMIN_EMAIL);
  if (!existing) {
    await createUser(tenantId, { name: 'Admin Fase3', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
  }

  agent = request.agent(app);
  const loginRes = await agent.post('/api/auth/login').send({ email: ADMIN_EMAIL, password: 'senha-teste-123' });
  assert.equal(loginRes.status, 200);
});

beforeEach(async () => {
  await resetDb();
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

function inboundPayload({ waId, text = 'oi', msgId, referral } = {}) {
  const msg = { id: msgId || 'wamid.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text } };
  if (referral) msg.referral = referral;
  return { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name: 'Cliente Fase3' } }],
    messages: [msg],
  } }] }] };
}

async function createConversationViaWebhook(waId, referral) {
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.auto.' + Math.random() }] }));
  const body = inboundPayload({ waId, referral });
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 300));
  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === waId);
  const detail = await agent.get(`/api/contacts/${contact.id}`);
  return { conversationId: detail.body.conversations[0].id, contactId: contact.id };
}

test('loss_reasons vem semeado por padrão (6 motivos)', async () => {
  const res = await agent.get('/api/loss-reasons');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 6);
  assert.ok(res.body.some((r) => r.name === 'Preço'));
});

test('origem: mensagem com referral de anúncio é capturada como referral_ad', async () => {
  const { conversationId } = await createConversationViaWebhook('5511600000001', {
    source_id: '12345', source_url: 'https://instagram.com/ad/xyz', headline: 'Anúncio Fase 3',
  });

  const res = await agent.get(`/api/conversations/${conversationId}/source`);
  assert.equal(res.status, 200);
  assert.equal(res.body.source_type, 'referral_ad');
  assert.equal(res.body.ad_id, '12345');
  assert.equal(res.body.ad_headline, 'Anúncio Fase 3');
});

test('origem: mensagem sem referral e sem campanha é \"direct\"', async () => {
  const { conversationId } = await createConversationViaWebhook('5511600000002');
  const res = await agent.get(`/api/conversations/${conversationId}/source`);
  assert.equal(res.body.source_type, 'direct');
});

test('oportunidade: criar, marcar como ganha, aparece no resumo', async () => {
  const { conversationId, contactId } = await createConversationViaWebhook('5511600000003');

  const create = await agent.post('/api/opportunities').send({
    contact_id: contactId, conversation_id: conversationId, title: 'Plano Premium', value: 5000,
  });
  assert.equal(create.status, 201);
  assert.equal(create.body.status, 'open');

  const won = await agent.post(`/api/opportunities/${create.body.id}/won`).send({});
  assert.equal(won.status, 200);
  assert.equal(won.body.status, 'won');
  assert.ok(won.body.won_at);

  const summary = await agent.get('/api/opportunities/summary');
  assert.equal(summary.status, 200);
  assert.ok(summary.body.won_count >= 1);
  assert.ok(summary.body.won_value >= 5000);
});

test('oportunidade: marcar como perdida exige loss_reason_id', async () => {
  const { conversationId, contactId } = await createConversationViaWebhook('5511600000004');
  const create = await agent.post('/api/opportunities').send({ contact_id: contactId, conversation_id: conversationId, title: 'Teste perdida', value: 1000 });

  const semMotivo = await agent.post(`/api/opportunities/${create.body.id}/lost`).send({});
  assert.equal(semMotivo.status, 400);

  const reasons = await agent.get('/api/loss-reasons');
  const reasonId = reasons.body[0].id;
  const comMotivo = await agent.post(`/api/opportunities/${create.body.id}/lost`).send({ loss_reason_id: reasonId });
  assert.equal(comMotivo.status, 200);
  assert.equal(comMotivo.body.status, 'lost');
  assert.equal(comMotivo.body.loss_reason_id, reasonId);
});

test('receita por origem: oportunidade ganha aparece somada na origem certa', async () => {
  const { conversationId, contactId } = await createConversationViaWebhook('5511600000005', {
    source_id: 'ad-99', headline: 'Campanha receita',
  });
  const create = await agent.post('/api/opportunities').send({ contact_id: contactId, conversation_id: conversationId, title: 'Deal receita', value: 3000 });
  await agent.post(`/api/opportunities/${create.body.id}/won`).send({});

  const res = await agent.get('/api/opportunities/revenue-by-source');
  assert.equal(res.status, 200);
  const row = res.body.find((r) => r.source_type === 'referral_ad');
  assert.ok(row, 'deveria ter uma linha de origem referral_ad');
  assert.ok(row.revenue >= 3000);
  assert.equal(row.won, 1);
});

test('tarefas: criar, listar minhas, completar', async () => {
  const { contactId } = await createConversationViaWebhook('5511600000006');

  const create = await agent.post('/api/tasks').send({ contact_id: contactId, title: 'Retornar sobre proposta', due_at: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(create.status, 201);
  assert.equal(create.body.status, 'pending');

  const mine = await agent.get('/api/tasks/mine');
  assert.equal(mine.status, 200);
  assert.ok(mine.body.some((t) => t.id === create.body.id));

  const completed = await agent.post(`/api/tasks/${create.body.id}/complete`);
  assert.equal(completed.status, 200);
  assert.equal(completed.body.status, 'completed');
  assert.ok(completed.body.completed_at);

  const mineAfter = await agent.get('/api/tasks/mine');
  assert.ok(!mineAfter.body.some((t) => t.id === create.body.id), 'tarefa completada não deveria mais aparecer em pendentes');
});
