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

// Métricas por nó do construtor + salvar o fluxo preservando os nós.

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-metricas@tractom.com.br';
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
  await new Promise((r) => setTimeout(r, 200));
}
const leadSays = (waId, text) => webhook({
  contacts: [{ wa_id: waId, profile: { name: 'Lead' } }],
  messages: [{ id: 'wamid.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text } }],
});

const FLOW = {
  name: 'Cursos', trigger_type: 'keyword', trigger_config: { keyword: 'curso' },
  steps: [
    { client_id: 'nome', step_type: 'ask_question', config: { text: 'Seu nome?', save_to: 'name' }, next_step_id: 'q' },
    {
      client_id: 'q', step_type: 'ask_question',
      config: { text: 'Qual curso?', reply_type: 'numbered', options: ['Medicina', 'Enfermagem'], branch_by_option: true, save_to: 'custom', custom_field: 'Curso' },
      option_next: { 0: 'med' }, next_step_id: 'fim',
    },
    { client_id: 'med', step_type: 'send_message', config: { text: 'Medicina!' }, next_step_id: 'fim' },
    { client_id: 'fim', step_type: 'send_message', config: { text: 'Obrigado!' } },
  ],
};

test('salvar o fluxo preserva os ids dos nós existentes (e um formulário em andamento continua)', async () => {
  const flow = (await agent.post('/api/automation-flows').send(FLOW)).body;
  const stepsBefore = (await agent.get(`/api/automation-flows/${flow.id}`)).body.steps;
  const idOf = (text) => stepsBefore.find((s) => s.config.text === text).id;

  await leadSays('5544955550001', 'quero o curso');
  assert.equal(sent.at(-1).text.body, 'Seu nome?');

  // Salva como o canvas faz: nós existentes como "s<id>", um nó novo, e sem o nó "Medicina!".
  const saved = (await agent.patch(`/api/automation-flows/${flow.id}`).send({
    steps: [
      { client_id: 's' + idOf('Seu nome?'), step_type: 'ask_question', config: { text: 'Seu nome completo?', save_to: 'name' }, next_step_id: 's' + idOf('Qual curso?') },
      { client_id: 's' + idOf('Qual curso?'), step_type: 'ask_question', config: { text: 'Qual curso?', reply_type: 'numbered', options: ['Medicina', 'Enfermagem'], save_to: 'custom', custom_field: 'Curso' }, next_step_id: 'novo' },
      { client_id: 'novo', step_type: 'send_message', config: { text: 'Novo nó' }, next_step_id: 's' + idOf('Obrigado!') },
      { client_id: 's' + idOf('Obrigado!'), step_type: 'send_message', config: { text: 'Obrigado!' } },
    ],
  })).body;

  const after = saved.steps;
  assert.equal(after.find((s) => s.config.text === 'Seu nome completo?').id, idOf('Seu nome?'), 'id mantido');
  assert.equal(after.find((s) => s.config.text === 'Qual curso?').id, idOf('Qual curso?'));
  assert.ok(!after.some((s) => s.config.text === 'Medicina!'), 'nó removido do canvas sai do banco');
  assert.ok(after.some((s) => s.config.text === 'Novo nó'));

  // O lead que estava respondendo continua de onde parou.
  await leadSays('5544955550001', 'Maria');
  assert.equal(sent.at(-1).text.body, 'Qual curso?\n\n1. Medicina\n2. Enfermagem');
});

test('métricas: execuções, respostas, opções, entrega/leitura e resumo do fluxo', async () => {
  const flow = (await agent.post('/api/automation-flows').send(FLOW)).body;
  const steps = (await agent.get(`/api/automation-flows/${flow.id}`)).body.steps;
  const idOf = (text) => String(steps.find((s) => s.config.text === text).id);

  // 3 leads: dois escolhem Medicina, um Enfermagem; um deles responde inválido antes.
  for (const [waId, choice] of [['5544955550010', '1'], ['5544955550011', 'medicina'], ['5544955550012', '2']]) {
    await leadSays(waId, 'curso');
    await leadSays(waId, 'Ana');
    if (waId.endsWith('12')) await leadSays(waId, 'não sei');
    await leadSays(waId, choice);
  }
  // Um lead que só começou.
  await leadSays('5544955550013', 'curso');

  // Status de entrega das perguntas "Qual curso?": uma lida, uma entregue.
  const qMsgs = (await query('SELECT wa_message_id FROM messages WHERE automation_step_id = $1 ORDER BY id', [idOf('Qual curso?')])).rows;
  await webhook({ statuses: [{ id: qMsgs[0].wa_message_id, status: 'read' }, { id: qMsgs[1].wa_message_id, status: 'delivered' }] });

  const m = (await agent.get(`/api/automation-flows/${flow.id}/metrics?days=30`)).body;
  assert.equal(m.summary.runs, 4);
  assert.equal(m.summary.contacts, 4);
  assert.equal(m.summary.completed, 3);
  assert.equal(m.summary.in_progress, 1);
  assert.deepEqual(m.summary.captured, { name: 3, custom: 3 });

  const q = m.steps[idOf('Qual curso?')];
  assert.equal(q.executions, 3);
  assert.equal(q.answered, 3);
  assert.equal(q.invalid, 1);
  assert.deepEqual(q.options, { 0: 2, 1: 1 });
  assert.equal(q.wa_messages, 4, '3 perguntas + 1 repergunta');
  assert.equal(q.delivered, 2);
  assert.equal(q.read, 1);

  assert.equal(m.steps[idOf('Seu nome?')].executions, 4);
  assert.equal(m.steps[idOf('Medicina!')].executions, 2);
  assert.equal(m.steps[idOf('Obrigado!')].executions, 3);

  const all = (await agent.get(`/api/automation-flows/${flow.id}/metrics?days=all`)).body;
  assert.equal(all.days, null);
  assert.equal(all.summary.runs, 4);
});
