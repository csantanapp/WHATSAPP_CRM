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
const ADMIN_EMAIL = 'admin-automacaocanvas@tractom.com.br';
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
    await createUser(tenantId, { name: 'Admin Automacao Canvas', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
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
    contacts: [{ wa_id: waId, profile: { name: 'Cliente Canvas ' + waId } }],
    messages: [{ id: 'wamid.' + waId + '.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text } }],
  } }] }] };
}

async function sendInbound(waId, text) {
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.out.' + Math.random() }] }));
  const body = inboundPayload(waId, text);
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 400));
}

test('salvar passos com client_id persiste o grafo (next_step_id + branching true/false)', async () => {
  const created = await agent.post('/api/automation-flows').send({
    name: 'Fluxo com ramificação', trigger_type: 'first_message', trigger_config: {}, steps: [],
  });
  assert.equal(created.status, 201);

  const saved = await agent.patch('/api/automation-flows/' + created.body.id).send({
    steps: [
      { client_id: 'a', step_type: 'condition', config: { check: 'tag_exists', tag: 'vip' }, next_step_id_true: 'b', next_step_id_false: 'c', position_x: 100, position_y: 50 },
      { client_id: 'b', step_type: 'send_message', config: { text: 'Oi VIP!' }, position_x: 300, position_y: 0 },
      { client_id: 'c', step_type: 'end', config: { label: 'Sem interesse' }, position_x: 300, position_y: 120 },
    ],
  });
  assert.equal(saved.status, 200);

  const stepA = saved.body.steps.find((s) => s.step_type === 'condition');
  const stepB = saved.body.steps.find((s) => s.step_type === 'send_message');
  const stepC = saved.body.steps.find((s) => s.step_type === 'end');

  assert.equal(stepA.next_step_id_true, stepB.id);
  assert.equal(stepA.next_step_id_false, stepC.id);
  assert.equal(stepA.position_x, 100);
  assert.equal(stepA.position_y, 50);
  assert.equal(stepA.position, 0, 'primeiro passo da lista deve ficar na position 0 (entrada do fluxo)');
});

test('salvar sem client_id mantém o encadeamento linear antigo (compatibilidade)', async () => {
  const created = await agent.post('/api/automation-flows').send({
    name: 'Fluxo legado', trigger_type: 'first_message', trigger_config: {}, steps: [],
  });

  const saved = await agent.patch('/api/automation-flows/' + created.body.id).send({
    steps: [
      { step_type: 'send_message', config: { text: 'Oi' } },
      { step_type: 'add_tag', config: { tag: 'lead' } },
    ],
  });
  assert.equal(saved.status, 200);
  const first = saved.body.steps.find((s) => s.step_type === 'send_message');
  const second = saved.body.steps.find((s) => s.step_type === 'add_tag');
  assert.equal(first.next_step_id, second.id);
  assert.equal(second.next_step_id, null);
});

test('nó "repetir" apontando pra um passo anterior não trava a run (guarda de loop)', async () => {
  const created = await agent.post('/api/automation-flows').send({
    name: 'Fluxo em loop', trigger_type: 'first_message', trigger_config: {}, steps: [],
  });

  await agent.patch('/api/automation-flows/' + created.body.id).send({
    steps: [
      { client_id: 'a', step_type: 'add_tag', config: { tag: 'tocou' }, next_step_id: 'b' },
      { client_id: 'b', step_type: 'repeat', config: {}, next_step_id: 'a' },
    ],
  });

  await sendInbound('5511400000001', 'oi');

  const runs = await query(
    `SELECT ar.status FROM automation_runs ar
     JOIN automation_flows af ON af.id = ar.automation_flow_id
     WHERE af.id = $1`,
    [created.body.id]
  );
  assert.equal(runs.rows.length, 1);
  assert.equal(runs.rows[0].status, 'stopped', 'a guarda de loop deve parar a run em vez de travar pra sempre');
});

test('nó "Classificar (IA)" em modo mock sempre segue o ramo false (sem IA real configurada)', async () => {
  const created = await agent.post('/api/automation-flows').send({
    name: 'Fluxo com IA', trigger_type: 'first_message', trigger_config: {}, steps: [],
  });

  await agent.patch('/api/automation-flows/' + created.body.id).send({
    steps: [
      { client_id: 'a', step_type: 'classify_ai', config: { question: 'O cliente quer marcar horário?' }, next_step_id_true: 'b', next_step_id_false: 'c' },
      { client_id: 'b', step_type: 'add_tag', config: { tag: 'quer-marcar' } },
      { client_id: 'c', step_type: 'add_tag', config: { tag: 'sem-interesse' } },
    ],
  });

  await sendInbound('5511400000002', 'oi');
  await new Promise((r) => setTimeout(r, 300));

  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === '5511400000002');
  assert.ok(contact.tags.includes('sem-interesse'));
  assert.ok(!contact.tags.includes('quer-marcar'));
});
