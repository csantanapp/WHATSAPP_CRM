import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail } from '../src/repositories/users.js';
import { getSetting } from '../src/repositories/settings.js';
import { loadWhatsAppCredentials, wa } from '../src/whatsapp/credentials.js';

// Conectar o WhatsApp pela tela Conexões: credenciais no banco (segredos
// criptografados), valem mais que o .env, nunca voltam pra tela.

let tenantId;
const realFetch = globalThis.fetch;
const graphCalls = [];

async function login(role) {
  const email = `${role}-wacred@tractom.com.br`;
  if (!(await findUserByEmail(tenantId, email))) {
    await createUser(tenantId, { name: role, email, password: 'senha-teste-123', role });
  }
  const ag = request.agent(createApp());
  assert.equal((await ag.post('/api/auth/login').send({ email, password: 'senha-teste-123' })).status, 200);
  return ag;
}

before(async () => {
  process.env.ENCRYPTION_KEY = 'b'.repeat(64);
  for (const k of ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN']) delete process.env[k];
  tenantId = await getDefaultTenantId();
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    graphCalls.push({ url: u, method: opts.method || 'GET', auth: opts.headers?.Authorization });
    if (u.includes('/subscribed_apps')) return new Response(JSON.stringify({ success: true }), { status: 200 });
    return new Response(JSON.stringify({ display_phone_number: '+55 11 99999-0000', verified_name: 'IASG' }), { status: 200 });
  };
});
beforeEach(async () => { await resetDb(); await loadWhatsAppCredentials(); graphCalls.length = 0; });
after(async () => { globalThis.fetch = realFetch; await closeDb(); });

test('admin salva as credenciais: ficam criptografadas, valem pro envio e não voltam pra tela', async () => {
  const admin = await login('admin');
  const empty = (await admin.get('/api/settings/whatsapp-credentials')).body;
  assert.equal(empty.has_access_token, false);
  assert.match(empty.webhook_url, /\/webhook\/whatsapp$/);

  const res = await admin.put('/api/settings/whatsapp-credentials').send({
    phone_number_id: '123456789012345', waba_id: '109876543210987', access_token: 'EAAsegredo123', app_secret: 'chave-secreta-do-app',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status.connected, true);
  assert.equal(res.body.subscription.ok, true);
  assert.equal(res.body.has_access_token, true);
  assert.equal(res.body.has_app_secret, true);
  assert.ok(res.body.verify_token, 'gera o token de verificação do webhook');
  assert.ok(!JSON.stringify(res.body).includes('EAAsegredo123'));
  assert.ok(!JSON.stringify(res.body).includes('chave-secreta-do-app'));

  const stored = await getSetting('whatsapp_credentials');
  assert.ok(!String(stored).includes('EAAsegredo123'), 'token gravado criptografado');
  assert.ok(!String(stored).includes('chave-secreta-do-app'), 'chave gravada criptografada');

  assert.equal(wa().accessToken, 'EAAsegredo123');
  assert.ok(graphCalls.some((c) => c.url.includes('109876543210987/subscribed_apps') && c.method === 'POST' && c.auth === 'Bearer EAAsegredo123'));

  // Campos vazios mantêm o que já estava salvo.
  const again = await admin.put('/api/settings/whatsapp-credentials').send({ phone_number_id: '123456789012345', access_token: '', app_secret: '' });
  assert.equal(again.status, 200);
  assert.equal(wa().accessToken, 'EAAsegredo123');
  assert.equal(again.body.verify_token, res.body.verify_token, 'token de verificação não muda');

  // A Meta valida o webhook com o token salvo.
  const app = createApp();
  const ok = await request(app).get('/webhook/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': res.body.verify_token, 'hub.challenge': '42' });
  assert.equal(ok.status, 200);
  assert.equal(ok.text, '42');
  const bad = await request(app).get('/webhook/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': '42' });
  assert.equal(bad.status, 403);
});

test('dados inválidos ou faltando dão 400 com explicação', async () => {
  const admin = await login('admin');
  const r1 = await admin.put('/api/settings/whatsapp-credentials').send({ phone_number_id: 'abc', access_token: 'x', app_secret: 'y' });
  assert.equal(r1.status, 400);
  const r2 = await admin.put('/api/settings/whatsapp-credentials').send({ phone_number_id: '123456789012345' });
  assert.equal(r2.status, 400);
  assert.match(r2.body.error, /token/i);
});

test('supervisor e atendente não veem nem trocam as credenciais', async () => {
  for (const role of ['supervisor', 'atendente']) {
    const ag = await login(role);
    assert.equal((await ag.get('/api/settings/whatsapp-credentials')).status, 403);
    assert.equal((await ag.put('/api/settings/whatsapp-credentials').send({ phone_number_id: '123456789012345', access_token: 'x', app_secret: 'y' })).status, 403);
  }
});
