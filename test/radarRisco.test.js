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

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-radarrisco@tractom.com.br';
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
    await createUser(tenantId, { name: 'Admin Radar Risco', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
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

function inboundPayload(waId, text = 'oi') {
  return { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name: 'Cliente Radar ' + waId } }],
    messages: [{ id: 'wamid.' + waId + '.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text } }],
  } }] }] };
}

async function createConv(waId, text) {
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.out.' + Math.random() }] }));
  const body = inboundPayload(waId, text);
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 300));
  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === waId);
  const detail = await agent.get(`/api/contacts/${contact.id}`);
  return detail.body.conversations[0].id;
}

async function backdateConversation(conversationId, hoursAgo) {
  await query(
    `UPDATE conversations SET last_message_at = now() - ($2 || ' hours')::interval WHERE id = $1`,
    [conversationId, String(hoursAgo)]
  );
}

test('conversa parada ha mais de 24h sem proximo passo entra como critico', async () => {
  const conv = await createConv('5511300000001', 'oi');
  await backdateConversation(conv, 30);

  const res = await agent.get('/api/radar/risk');
  assert.equal(res.status, 200);
  const item = res.body.items.find((i) => i.id === conv);
  assert.ok(item, 'conversa deveria aparecer no radar');
  assert.equal(item.category, 'critico');
  assert.ok(res.body.counts.critico >= 1);
});

test('conversa parada ha menos de 24h sem proximo passo entra como em_risco', async () => {
  const conv = await createConv('5511300000002', 'oi');
  await backdateConversation(conv, 5);

  const res = await agent.get('/api/radar/risk');
  const item = res.body.items.find((i) => i.id === conv);
  assert.ok(item);
  assert.equal(item.category, 'em_risco');
});

test('conversa com tarefa futura agendada vira em_voo mesmo parada ha dias', async () => {
  const conv = await createConv('5511300000003', 'oi');
  await backdateConversation(conv, 48);
  await agent.post('/api/tasks').send({
    conversation_id: conv,
    title: 'Retornar contato',
    due_at: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
  });

  const res = await agent.get('/api/radar/risk');
  const item = res.body.items.find((i) => i.id === conv);
  assert.ok(item);
  assert.equal(item.category, 'em_voo');
});

test('conversa muito recente (menos de 1h parada) nao aparece no radar', async () => {
  const conv = await createConv('5511300000004', 'oi');
  const res = await agent.get('/api/radar/risk');
  assert.ok(!res.body.items.map((i) => i.id).includes(conv));
});

test('conversa fechada nao aparece no radar', async () => {
  const conv = await createConv('5511300000005', 'oi');
  await backdateConversation(conv, 50);
  await agent.patch(`/api/conversations/${conv}/status`).send({ status: 'closed' });

  const res = await agent.get('/api/radar/risk');
  assert.ok(!res.body.items.map((i) => i.id).includes(conv));
});
