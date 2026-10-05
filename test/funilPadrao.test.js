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
const ADMIN_EMAIL = 'admin-funilpadrao@tractom.com.br';
let app;
let agent;

before(async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'fake-token';
  app = createApp();

  const tenantId = await getDefaultTenantId();
  const existing = await findUserByEmail(tenantId, ADMIN_EMAIL);
  if (!existing) {
    await createUser(tenantId, { name: 'Admin Funil Padrao', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
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

test('tornar um funil padrão desmarca o antigo padrão e novo lead passa a cair nele', async () => {
  const first = await agent.post('/api/funnels').send({ name: 'Funil Original' });
  await agent.post('/api/funnels/' + first.body.id + '/set-default');

  const created = await agent.post('/api/funnels').send({ name: 'Funil Novo' });
  assert.equal(created.status, 201);
  assert.equal(created.body.is_default, false);

  const setDefault = await agent.post('/api/funnels/' + created.body.id + '/set-default');
  assert.equal(setDefault.status, 200);
  assert.equal(setDefault.body.is_default, true);

  const funnelsAfter = await agent.get('/api/funnels');
  const nowDefault = funnelsAfter.body.filter((f) => f.is_default);
  assert.equal(nowDefault.length, 1, 'só pode haver 1 funil padrão por vez');
  assert.equal(nowDefault[0].id, created.body.id);

  // novo lead (sem palavra-chave de campanha) deve cair no novo funil padrão
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.out.' + Math.random() }] }));
  const waId = '5511700000001';
  const body = { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name: 'Lead Funil Padrao' } }],
    messages: [{ id: 'wamid.' + waId + '.' + Date.now(), from: waId, type: 'text', text: { body: 'oi' } }],
  } }] }] };
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 400));

  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === waId);
  const detail = await agent.get('/api/contacts/' + contact.id);
  assert.equal(detail.body.conversations[0].funnel_id, created.body.id, 'o lead novo deveria ter caído no novo funil padrão');
});

test('atendente não pode tornar um funil padrão (RBAC)', async () => {
  const email = `atendente-funilpadrao-${Date.now()}@tractom.com.br`;
  const tenantId = await getDefaultTenantId();
  await createUser(tenantId, { name: 'Atendente Funil Padrao', email, password: 'senha12345', role: 'atendente' });
  const atendenteAgent = request.agent(app);
  await atendenteAgent.post('/api/auth/login').send({ email, password: 'senha12345' });

  const created = await agent.post('/api/funnels').send({ name: 'Funil Restrito' });
  const res = await atendenteAgent.post('/api/funnels/' + created.body.id + '/set-default');
  assert.equal(res.status, 403);
});
