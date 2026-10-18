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

// Nó "Conectar Automação" (start_flow): encerra o fluxo atual e
// continua a conversa no primeiro passo de outro fluxo ativo.

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-irpara@tractom.com.br';
let agent;
let sent;

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
  sent = [];
  installMockFetch(async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return jsonResponse({ messages: [{ id: 'wamid.out.' + sent.length }] });
  });
});

after(async () => {
  restoreFetch();
  await closeDb();
});

async function webhook(value) {
  const body = { entry: [{ changes: [{ value: { messaging_product: 'whatsapp', ...value } }] }] };
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(Buffer.from(JSON.stringify(body))).digest('hex');
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', sig).send(body);
  await new Promise((r) => setTimeout(r, 250));
}
const leadSays = (waId, text) => webhook({
  contacts: [{ wa_id: waId, profile: { name: 'Lead' } }],
  messages: [{ id: 'wamid.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text } }],
});
const texts = () => sent.map((m) => m.text?.body).filter(Boolean);

async function createFlow(body) {
  const res = await agent.post('/api/automation-flows').send(body);
  assert.equal(res.status, 201);
  return res.body;
}

// Fluxo "destino": só roda quando chamado (gatilho manual), pergunta e responde.
const destino = () => createFlow({
  name: 'Agendamento', trigger_type: 'manual',
  steps: [
    { client_id: 'oi', step_type: 'send_message', config: { text: 'Vamos agendar!' }, next_step_id: 'dia' },
    { client_id: 'dia', step_type: 'ask_question', config: { text: 'Qual dia?' }, next_step_id: 'ok' },
    { client_id: 'ok', step_type: 'send_message', config: { text: 'Agendado.' } },
  ],
});
const origem = (targetId) => createFlow({
  name: 'Boas-vindas', trigger_type: 'keyword', trigger_config: { keyword: 'curso' },
  steps: [
    { client_id: 'm', step_type: 'send_message', config: { text: 'Olá!' }, next_step_id: 'go' },
    { client_id: 'go', step_type: 'start_flow', config: { flow_id: targetId } },
  ],
});

test('leva o lead pro primeiro passo da outra automação e ela continua normalmente', async () => {
  const b = await destino();
  const a = await origem(b.id);

  await leadSays('5544955560001', 'quero o curso');
  assert.deepEqual(texts(), ['Olá!', 'Vamos agendar!', 'Qual dia?']);

  const runs = (await query('SELECT automation_flow_id, status FROM automation_runs ORDER BY id')).rows;
  assert.deepEqual(runs.map((r) => [Number(r.automation_flow_id), r.status]), [[Number(a.id), 'completed'], [Number(b.id), 'waiting_reply']]);

  // A resposta é tratada pela automação de destino.
  await leadSays('5544955560001', 'segunda');
  assert.equal(texts().at(-1), 'Agendado.');

  // O nó conta nas métricas da automação de origem.
  const goStep = a.steps.find((s) => s.step_type === 'start_flow');
  const log = await query('SELECT outcome FROM automation_step_logs WHERE step_id = $1', [goStep.id]);
  assert.deepEqual(log.rows.map((r) => r.outcome), ['started_flow']);
});

test('automação de destino pausada: o fluxo atual só termina', async () => {
  const b = await destino();
  await agent.patch(`/api/automation-flows/${b.id}/active`).send({ is_active: false });
  await origem(b.id);

  await leadSays('5544955560002', 'quero o curso');
  assert.deepEqual(texts(), ['Olá!']);
  const runs = (await query('SELECT status FROM automation_runs')).rows;
  assert.deepEqual(runs.map((r) => r.status), ['completed']);
});

test('automação de destino excluída ou não escolhida: o fluxo atual só termina', async () => {
  await origem(null);
  await leadSays('5544955560003', 'quero o curso');
  assert.deepEqual(texts(), ['Olá!']);

  sent = [];
  await resetDb();
  const b = await destino();
  await origem(b.id);
  await agent.delete(`/api/automation-flows/${b.id}`);
  await leadSays('5544955560004', 'quero o curso');
  assert.deepEqual(texts(), ['Olá!']);
});

test('A → B → A sem pausa no meio não entra em loop infinito', async () => {
  const a = await origem(null);
  const b = await createFlow({
    name: 'Volta', trigger_type: 'manual',
    steps: [
      { client_id: 'm', step_type: 'send_message', config: { text: 'B' }, next_step_id: 'go' },
      { client_id: 'go', step_type: 'start_flow', config: { flow_id: a.id } },
    ],
  });
  await agent.patch(`/api/automation-flows/${a.id}`).send({
    steps: a.steps.map((s) => ({
      client_id: 's' + s.id, step_type: s.step_type,
      config: s.step_type === 'start_flow' ? { flow_id: b.id } : s.config,
      next_step_id: s.next_step_id ? 's' + s.next_step_id : null,
    })),
  });

  await leadSays('5544955560005', 'quero o curso');
  // 1 execução original + 5 saltos permitidos, depois para.
  assert.deepEqual(texts(), ['Olá!', 'B', 'Olá!', 'B', 'Olá!', 'B']);
  const pending = await query(`SELECT count(*)::int AS n FROM automation_runs WHERE status NOT IN ('completed','stopped')`);
  assert.equal(pending.rows[0].n, 0);
});
