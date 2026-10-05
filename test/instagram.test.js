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
const ADMIN_EMAIL = 'admin-instagram@tractom.com.br';
let app;
let agent;

before(async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'fake-token';
  process.env.INSTAGRAM_VERIFY_TOKEN = 'ig-verify-me';
  process.env.INSTAGRAM_PAGE_ACCESS_TOKEN = 'fake-ig-token';
  process.env.INSTAGRAM_PAGE_ID = '999888777';
  app = createApp();

  const tenantId = await getDefaultTenantId();
  const existing = await findUserByEmail(tenantId, ADMIN_EMAIL);
  if (!existing) {
    await createUser(tenantId, { name: 'Admin Instagram', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
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

test('GET /webhook/instagram valida o verify_token e devolve o challenge', async () => {
  const res = await request(app)
    .get('/webhook/instagram')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'ig-verify-me', 'hub.challenge': 'abc123' });
  assert.equal(res.status, 200);
  assert.equal(res.text, 'abc123');
});

test('GET /webhook/instagram com token errado é rejeitado', async () => {
  const res = await request(app)
    .get('/webhook/instagram')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': 'abc123' });
  assert.equal(res.status, 403);
});

test('POST /webhook/instagram sem assinatura válida é rejeitado (401)', async () => {
  const body = { entry: [{ messaging: [{ sender: { id: '123' }, message: { mid: 'm1', text: 'oi' } }] }] };
  const res = await request(app).post('/webhook/instagram').send(body);
  assert.equal(res.status, 401);
});

test('mensagem recebida do Instagram cria contato (channel=instagram) e conversa, aparece no Kanban', async () => {
  installMockFetch(async (url) => {
    if (String(url).includes('?fields=name,username')) {
      return jsonResponse({ name: 'Fulano Instagram', username: 'fulano.ig' });
    }
    return jsonResponse({});
  });

  const igsid = '1789000000001';
  const body = { entry: [{ id: 'page1', messaging: [{ sender: { id: igsid }, recipient: { id: 'page1' }, timestamp: Date.now(), message: { mid: 'mid.' + igsid, text: 'Oi, vi o produto de vocês no Instagram!' } }] }] };
  const res = await request(app).post('/webhook/instagram').set('x-hub-signature-256', signPayload(body)).send(body);
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 400));

  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.channel === 'instagram');
  assert.ok(contact, 'deveria ter criado um contato do Instagram');
  assert.equal(contact.name, '@fulano.ig');

  const detail = await agent.get('/api/contacts/' + contact.id);
  assert.equal(detail.body.conversations.length, 1);

  const messages = await agent.get('/api/conversations/' + detail.body.conversations[0].id + '/messages');
  assert.equal(messages.body.length, 1);
  assert.equal(messages.body[0].body, 'Oi, vi o produto de vocês no Instagram!');
});

test('mensagem de echo (is_echo) é ignorada, não cria conversa duplicada', async () => {
  installMockFetch(async () => jsonResponse({}));
  const igsid = '1789000000002';
  const echoBody = { entry: [{ messaging: [{ sender: { id: 'page1' }, recipient: { id: igsid }, message: { mid: 'mid.echo', text: 'oi', is_echo: true } }] }] };
  await request(app).post('/webhook/instagram').set('x-hub-signature-256', signPayload(echoBody)).send(echoBody);
  await new Promise((r) => setTimeout(r, 200));

  const contacts = await agent.get('/api/contacts');
  assert.ok(!contacts.body.find((c) => c.ig_user_id === igsid));
});

test('reenvio do mesmo mid (retry da Meta) não duplica a mensagem', async () => {
  installMockFetch(async () => jsonResponse({ name: 'X', username: 'x' }));
  const igsid = '1789000000003';
  const body = { entry: [{ messaging: [{ sender: { id: igsid }, message: { mid: 'mid.dup', text: 'oi' } }] }] };
  await request(app).post('/webhook/instagram').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 300));
  await request(app).post('/webhook/instagram').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 300));

  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.ig_user_id === igsid);
  const detail = await agent.get('/api/contacts/' + contact.id);
  const messages = await agent.get('/api/conversations/' + detail.body.conversations[0].id + '/messages');
  assert.equal(messages.body.length, 1, 'não deveria duplicar a mensagem reenviada com o mesmo mid');
});

test('GET /settings/instagram-status reflete credenciais configuradas', async () => {
  installMockFetch(async () => jsonResponse({ name: 'Página Teste', instagram_business_account: { username: 'tractom.oficial' } }));
  const res = await agent.get('/api/settings/instagram-status');
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.igUsername, 'tractom.oficial');
});

test('responder uma conversa do Instagram chama a Send API certa (não a do WhatsApp)', async () => {
  installMockFetch(async () => jsonResponse({ name: 'Y', username: 'y' }));
  const igsid = '1789000000004';
  const inboundBody = { entry: [{ messaging: [{ sender: { id: igsid }, message: { mid: 'mid.resp', text: 'oi' } }] }] };
  await request(app).post('/webhook/instagram').set('x-hub-signature-256', signPayload(inboundBody)).send(inboundBody);
  await new Promise((r) => setTimeout(r, 300));

  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.ig_user_id === igsid);
  const detail = await agent.get('/api/contacts/' + contact.id);
  const conversationId = detail.body.conversations[0].id;

  installMockFetch(async (url, opts) => {
    assert.ok(String(url).includes('me/messages'));
    const sentBody = JSON.parse(opts.body);
    assert.equal(sentBody.recipient.id, igsid);
    assert.equal(sentBody.message.text, 'Oi! Claro, posso te ajudar.');
    return jsonResponse({ recipient_id: igsid, message_id: 'mid.out.1' });
  });

  const res = await agent.post('/api/conversations/' + conversationId + '/messages').send({ text: 'Oi! Claro, posso te ajudar.' });
  assert.equal(res.status, 201);
});
