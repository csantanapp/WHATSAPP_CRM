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
const ADMIN_EMAIL = 'admin-horariocomercial@tractom.com.br';
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
    await createUser(tenantId, { name: 'Admin Horario Comercial', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
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

function inboundPayload(waId, text) {
  return { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name: 'Cliente Horario ' + waId } }],
    messages: [{ id: 'wamid.' + waId + '.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text } }],
  } }] }] };
}

async function sendInbound(waId, text) {
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.out.' + Math.random() }] }));
  const body = inboundPayload(waId, text);
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 400));
}

async function createFlowWithBusinessHours(weekdays, start, end, tz) {
  const created = await agent.post('/api/automation-flows').send({
    name: 'Fora do expediente', trigger_type: 'first_message', trigger_config: {}, steps: [],
  });
  await agent.patch('/api/automation-flows/' + created.body.id).send({
    steps: [
      {
        client_id: 'a', step_type: 'condition',
        config: { check: 'business_hours', business_hours: { weekdays, start, end, tz }, true_label: 'Aberto', false_label: 'Fechado' },
        next_step_id_true: 'open_end', next_step_id_false: 'b',
      },
      { client_id: 'open_end', step_type: 'end', config: { label: 'Dentro do horário' } },
      { client_id: 'b', step_type: 'add_tag', config: { tag: 'fora-do-expediente' } },
    ],
  });
  return created.body.id;
}

test('condição "horário comercial": fora da janela configurada, segue o ramo falso', async () => {
  // janela deliberadamente 2h no futuro (UTC) pra garantir que "agora" nunca
  // cai dentro dela, não importa quando o teste rodar.
  var future = new Date(Date.now() + 2 * 3600 * 1000);
  var startH = String(future.getUTCHours()).padStart(2, '0') + ':' + String(future.getUTCMinutes()).padStart(2, '0');
  var endFuture = new Date(future.getTime() + 3600 * 1000);
  var endH = String(endFuture.getUTCHours()).padStart(2, '0') + ':' + String(endFuture.getUTCMinutes()).padStart(2, '0');
  await createFlowWithBusinessHours([0, 1, 2, 3, 4, 5, 6], startH, endH, 'UTC');

  await sendInbound('5511600000001', 'oi');

  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === '5511600000001');
  assert.ok(contact.tags.includes('fora-do-expediente'), 'deveria ter seguido o ramo "fechado" e marcado a tag');
});

test('condição "horário comercial": dentro da janela (00:00-23:59), segue o ramo verdadeiro', async () => {
  await createFlowWithBusinessHours([0, 1, 2, 3, 4, 5, 6], '00:00', '23:59', 'UTC');

  await sendInbound('5511600000002', 'oi');

  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === '5511600000002');
  assert.ok(!contact.tags.includes('fora-do-expediente'), 'deveria ter seguido o ramo "aberto" e não marcado a tag');
});
