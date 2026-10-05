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
const ADMIN_EMAIL = 'admin-templates@tractom.com.br';
let app;
let agent;

before(async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'fake-token';
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = '999888777';
  app = createApp();

  const tenantId = await getDefaultTenantId();
  const existing = await findUserByEmail(tenantId, ADMIN_EMAIL);
  if (!existing) {
    await createUser(tenantId, { name: 'Admin Templates', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
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

async function createConv(waId, text) {
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.out.' + Math.random() }] }));
  const body = { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name: 'Cliente Templates ' + waId } }],
    messages: [{ id: 'wamid.' + waId + '.' + Date.now(), from: waId, type: 'text', text: { body: text } }],
  } }] }] };
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 300));
  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === waId);
  const detail = await agent.get('/api/contacts/' + contact.id);
  return detail.body.conversations[0].id;
}

const FAKE_TEMPLATES_RESPONSE = {
  data: [
    { id: '1', name: 'hello_world', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello there!' }] },
    { id: '2', name: 'em_revisao', language: 'pt_BR', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Ainda não aprovado' }] },
  ],
};

test('GET /templates retorna só os templates aprovados', async () => {
  installMockFetch(async () => jsonResponse(FAKE_TEMPLATES_RESPONSE));
  const res = await agent.get('/api/templates');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, 'hello_world');
});

test('POST /conversations/:id/send-template envia mesmo com a janela de 24h fechada', async () => {
  const convId = await createConv('5511800000001', 'oi');
  // fecha a janela de propósito (mensagem recebida há muito tempo)
  const { query } = await import('../src/db/pool.js');
  await query(`UPDATE conversations SET last_inbound_at = now() - interval '48 hours' WHERE id = $1`, [convId]);

  installMockFetch(async (url, opts) => {
    if (String(url).includes('/messages')) {
      const sentBody = JSON.parse(opts.body);
      assert.equal(sentBody.type, 'template');
      assert.equal(sentBody.template.name, 'hello_world');
      return jsonResponse({ messages: [{ id: 'wamid.template.123' }] });
    }
    return jsonResponse({});
  });

  const res = await agent.post('/api/conversations/' + convId + '/send-template').send({
    name: 'hello_world', language: 'en_US', components: [], preview: 'Hello there!',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.body, 'Hello there!');

  const messages = await agent.get('/api/conversations/' + convId + '/messages');
  const templateMsg = messages.body.find((m) => m.body === 'Hello there!');
  assert.ok(templateMsg, 'a mensagem de template deveria estar salva no histórico');
});

test('POST /conversations/:id/send-template sem name/language retorna 400', async () => {
  const convId = await createConv('5511800000002', 'oi');
  const res = await agent.post('/api/conversations/' + convId + '/send-template').send({});
  assert.equal(res.status, 400);
});
