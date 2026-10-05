import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { installMockFetch, restoreFetch, jsonResponse } from './helpers/mockFetch.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail } from '../src/repositories/users.js';

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-inbox@tractom.com.br';
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
    await createUser(tenantId, { name: 'Admin Inbox', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
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
    contacts: [{ wa_id: waId, profile: { name: 'Cliente Inbox ' + waId } }],
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

test('fila: só mostra conversas abertas e não atribuídas', async () => {
  const conv1 = await createConv('5511200000001', 'preciso de ajuda');
  const conv2 = await createConv('5511200000002', 'outra pessoa');
  await agent.patch(`/api/conversations/${conv2}/assign`).send({});

  const res = await agent.get('/api/inbox/conversations').query({ tab: 'queue' });
  assert.equal(res.status, 200);
  const ids = res.body.map((c) => c.id);
  assert.ok(ids.includes(conv1));
  assert.ok(!ids.includes(conv2), 'conversa já atribuída não deveria aparecer na fila');
});

test('minhas: só mostra conversas atribuídas a mim', async () => {
  const conv1 = await createConv('5511200000003', 'oi');
  await agent.patch(`/api/conversations/${conv1}/assign`).send({});

  const res = await agent.get('/api/inbox/conversations').query({ tab: 'mine' });
  const ids = res.body.map((c) => c.id);
  assert.ok(ids.includes(conv1));
});

test('fechadas: só mostra conversas com status closed', async () => {
  const conv1 = await createConv('5511200000004', 'oi');
  await agent.patch(`/api/conversations/${conv1}/status`).send({ status: 'closed' });

  const res = await agent.get('/api/inbox/conversations').query({ tab: 'closed' });
  const ids = res.body.map((c) => c.id);
  assert.ok(ids.includes(conv1));

  const abertas = await agent.get('/api/inbox/conversations').query({ tab: 'all' });
  assert.ok(!abertas.body.map((c) => c.id).includes(conv1), 'conversa fechada não deveria aparecer em "todas"');
});

test('busca por nome filtra corretamente', async () => {
  const conv1 = await createConv('5511200000005', 'oi');
  const res = await agent.get('/api/inbox/conversations').query({ tab: 'all', q: '5511200000005' });
  assert.ok(res.body.map((c) => c.id).includes(conv1));

  const resVazio = await agent.get('/api/inbox/conversations').query({ tab: 'all', q: 'NomeQueNaoExiste999' });
  assert.equal(resVazio.body.length, 0);
});

test('filtro de não lidos só mostra conversas com unread_count > 0', async () => {
  const conv1 = await createConv('5511200000006', 'oi');
  await agent.post(`/api/conversations/${conv1}/read`);

  const resNaoLidas = await agent.get('/api/inbox/conversations').query({ tab: 'all', unread: 'true' });
  assert.ok(!resNaoLidas.body.map((c) => c.id).includes(conv1), 'conversa já lida não deveria aparecer no filtro de não lidos');
});

test('último texto da conversa aparece no preview (inclusive tipo de mídia)', async () => {
  const conv1 = await createConv('5511200000007', 'minha última mensagem de texto');
  const res = await agent.get('/api/inbox/conversations').query({ tab: 'all' });
  const item = res.body.find((c) => c.id === conv1);
  assert.equal(item.last_message_body, 'minha última mensagem de texto');
});

test('GET /inbox/counts retorna contagem de cada aba', async () => {
  await createConv('5511200000008', 'oi');
  const res = await agent.get('/api/inbox/counts');
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.queue === 'number');
  assert.ok(typeof res.body.mine === 'number');
  assert.ok(typeof res.body.all === 'number');
  assert.ok(typeof res.body.closed === 'number');
});

test('atendente na aba "todas" só vê as suas + não atribuídas (mesma regra do Kanban)', async () => {
  const conv1 = await createConv('5511200000009', 'oi');
  const outroUser = await createUser(tenantId, { name: 'Outro Atendente Inbox', email: `outro-inbox-${Date.now()}@tractom.com.br`, password: 'senha12345', role: 'atendente' });
  await agent.patch(`/api/conversations/${conv1}/assign`).send({ user_id: outroUser.id });

  const meuEmail = `meu-inbox-${Date.now()}@tractom.com.br`;
  await createUser(tenantId, { name: 'Meu Atendente Inbox', email: meuEmail, password: 'senha12345', role: 'atendente' });
  const atendenteAgent = request.agent(app);
  await atendenteAgent.post('/api/auth/login').send({ email: meuEmail, password: 'senha12345' });

  const res = await atendenteAgent.get('/api/inbox/conversations').query({ tab: 'all' });
  assert.ok(!res.body.map((c) => c.id).includes(conv1), 'não deveria ver conversa atribuída a outro atendente');
});
