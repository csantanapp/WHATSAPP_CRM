import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { installMockFetch, restoreFetch, jsonResponse } from './helpers/mockFetch.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail } from '../src/repositories/users.js';
import { typingDelayMs } from '../src/services/typing.js';

// "Digitando..." antes das mensagens automáticas.

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-typing@tractom.com.br';
let agent;
let calls;

before(async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'fake-token';
  const tenantId = await getDefaultTenantId();
  if (!(await findUserByEmail(tenantId, ADMIN_EMAIL))) {
    await createUser(tenantId, { name: 'Admin', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
  }
  agent = request.agent(createApp());
  assert.equal((await agent.post('/api/auth/login').send({ email: ADMIN_EMAIL, password: 'senha-teste-123' })).status, 200);
});

beforeEach(async () => {
  await resetDb();
  calls = [];
  installMockFetch(async (url, opts) => {
    calls.push({ at: Date.now(), body: JSON.parse(opts.body) });
    return jsonResponse({ success: true, messages: [{ id: 'wamid.out.' + calls.length }] });
  });
  process.env.TYPING_SIMULATION = 'on';
});

after(async () => {
  process.env.TYPING_SIMULATION = 'off';
  restoreFetch();
  await closeDb();
});

async function leadSays(waId, text, msgId) {
  const body = { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name: 'Lead' } }],
    messages: [{ id: msgId, from: waId, type: 'text', text: { body: text } }],
  } }] }] };
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(Buffer.from(JSON.stringify(body))).digest('hex');
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', sig).send(body);
}

const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

test('tempo digitando é proporcional ao texto, com mínimo e máximo', () => {
  assert.equal(typingDelayMs('oi'), 1200);
  assert.equal(typingDelayMs('x'.repeat(60)), 3000);
  assert.equal(typingDelayMs('x'.repeat(500)), 5000);
  assert.equal(typingDelayMs('x'.repeat(500), 2), 2000);
});

test('mensagem automática sai depois do "digitando..." na mensagem do lead', async () => {
  await agent.patch('/api/settings/typing').send({ enabled: true, max_seconds: 1 });
  await agent.post('/api/automation-flows').send({
    name: 'Oi', trigger_type: 'first_message',
    steps: [{ client_id: 'a', step_type: 'send_message', config: { text: 'Olá! Em que posso ajudar?' } }],
  });

  const start = Date.now();
  await leadSays('5544944440001', 'oi', 'wamid.LEAD.1');
  assert.ok(await waitFor(() => calls.some((c) => c.body.type === 'text')), 'mensagem enviada');

  const [typing, message] = calls;
  assert.deepEqual(typing.body, {
    messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.LEAD.1', typing_indicator: { type: 'text' },
  });
  assert.equal(message.body.text.body, 'Olá! Em que posso ajudar?');
  assert.ok(message.at - typing.at >= 900, 'esperou o tempo de digitação antes de enviar');
  assert.ok(Date.now() - start < 4000);
});

test('desligado em Configurações: envia direto, sem "digitando..."', async () => {
  const cfg = (await agent.patch('/api/settings/typing').send({ enabled: false })).body;
  assert.equal(cfg.enabled, false);
  await agent.post('/api/automation-flows').send({
    name: 'Oi', trigger_type: 'first_message',
    steps: [{ client_id: 'a', step_type: 'send_message', config: { text: 'Olá!' } }],
  });
  await leadSays('5544944440002', 'oi', 'wamid.LEAD.2');
  // Só as chamadas deste lead: um "digitando..." atrasado do teste anterior
  // pode chegar aqui e não tem nada a ver com este cenário.
  const mine = () => calls.filter((c) => c.body.to === '5544944440002' || c.body.message_id === 'wamid.LEAD.2');
  assert.ok(await waitFor(() => mine().length >= 1));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(mine().length, 1);
  assert.equal(mine()[0].body.type, 'text');
});
