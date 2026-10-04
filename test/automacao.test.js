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
import { claimDueJobs, markJobDone } from '../src/jobs/scheduledJobs.js';
import { resumeRunAfterWait } from '../src/automation/engine.js';

// Fase 4 (núcleo): motor de automação avançado (condições, wait, novas ações),
// distribuição round-robin, opt-out (LGPD).

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-fase4@tractom.com.br';
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
    await createUser(tenantId, { name: 'Admin Fase4', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
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

function inboundPayload({ waId, text = 'oi', msgId } = {}) {
  return { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name: 'Cliente Fase4' } }],
    messages: [{ id: msgId || 'wamid.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text } }],
  } }] }] };
}

async function createConversationViaWebhook(waId, text) {
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.auto.' + Math.random() }] }));
  const body = inboundPayload({ waId, text });
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 300));
  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === waId);
  const detail = await agent.get(`/api/contacts/${contact.id}`);
  return { conversationId: detail.body.conversations[0].id, contactId: contact.id };
}

test('ação assign_user, remove_tag e create_task no fluxo first_message', async () => {
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.x' }] }));

  const userRes = await createUser(tenantId, { name: 'Atendente Fluxo', email: `atend-fluxo-${Date.now()}@tractom.com.br`, password: 'senha12345', role: 'atendente' });

  const flowRes = await agent.post('/api/automation-flows').send({
    name: 'Fluxo completo',
    trigger_type: 'first_message',
    steps: [
      { step_type: 'add_tag', config: { tag: 'quente' }, position: 0 },
      { step_type: 'remove_tag', config: { tag: 'quente' }, position: 1 },
      { step_type: 'assign_user', config: { user_id: userRes.id }, position: 2 },
      { step_type: 'create_task', config: { title: 'Ligar pro lead', due_in_hours: 24 }, position: 3 },
    ],
  });
  assert.equal(flowRes.status, 201);

  const { conversationId, contactId } = await createConversationViaWebhook('5511500000001', 'primeira mensagem');

  const detail = await agent.get(`/api/conversations/${conversationId}`);
  assert.equal(detail.body.assigned_user_id, String(userRes.id));

  const contact = await agent.get(`/api/contacts/${contactId}`);
  assert.ok(!contact.body.tags.includes('quente'), 'tag deveria ter sido removida pelo passo seguinte');

  const tasks = await query('SELECT * FROM tasks WHERE contact_id = $1', [contactId]);
  assert.equal(tasks.rows.length, 1);
  assert.equal(tasks.rows[0].title, 'Ligar pro lead');
});

test('condição tag_exists: ramo verdadeiro e falso levam a ações diferentes', async () => {
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.y' }] }));

  // Fluxo: condição tag "vip" -> true: add_tag "prioridade" | false: add_tag "padrao"
  const createFlow = await agent.post('/api/automation-flows').send({
    name: 'Fluxo condicional',
    trigger_type: 'first_message',
    steps: [{ step_type: 'condition', config: { check: 'tag_exists', tag: 'vip' }, position: 0 }],
  });
  const flowId = createFlow.body.id;
  const stepsBefore = await agent.get(`/api/automation-flows/${flowId}`);
  const conditionStepId = stepsBefore.body.steps[0].id;

  // Cria os dois ramos manualmente via SQL (a API de edição de passos com branch
  // fica pro construtor visual, fora do núcleo desta fase).
  const trueStep = await query(
    `INSERT INTO automation_flow_steps (automation_flow_id, step_type, config, position) VALUES ($1,'add_tag','{"tag":"prioridade"}',1) RETURNING *`,
    [flowId]
  );
  const falseStep = await query(
    `INSERT INTO automation_flow_steps (automation_flow_id, step_type, config, position) VALUES ($1,'add_tag','{"tag":"padrao"}',2) RETURNING *`,
    [flowId]
  );
  await query('UPDATE automation_flow_steps SET next_step_id_true = $2, next_step_id_false = $3 WHERE id = $1', [
    conditionStepId, trueStep.rows[0].id, falseStep.rows[0].id,
  ]);

  const { contactId } = await createConversationViaWebhook('5511500000002', 'oi');
  const contact = await agent.get(`/api/contacts/${contactId}`);
  assert.ok(contact.body.tags.includes('padrao'), 'sem a tag vip, deveria ter ido pro ramo falso');
  assert.ok(!contact.body.tags.includes('prioridade'));
});

test('wait: pausa a run, agenda job, e o worker retoma depois do tempo passar', async () => {
  installMockFetch(async (_url, opts) => jsonResponse({ messages: [{ id: 'wamid.wait.' + Math.random() }] }));

  const flowRes = await agent.post('/api/automation-flows').send({
    name: 'Fluxo com espera',
    trigger_type: 'first_message',
    steps: [
      { step_type: 'wait', config: { minutes: 60 }, position: 0 },
      { step_type: 'add_tag', config: { tag: 'retomou' }, position: 1 },
    ],
  });
  assert.equal(flowRes.status, 201);

  const { contactId } = await createConversationViaWebhook('5511500000003', 'oi');

  const runBefore = await query("SELECT * FROM automation_runs WHERE status = 'waiting_delay'");
  assert.equal(runBefore.rows.length, 1, 'deveria ter uma run pausada aguardando o wait');

  const jobsBefore = await claimDueJobs(10);
  assert.equal(jobsBefore.length, 0, 'job não deveria estar vencido ainda (agendado pra 60min no futuro)');

  // Simula o tempo passar: antecipa o run_at do job pra agora.
  await query("UPDATE scheduled_jobs SET run_at = now() - interval '1 minute', locked_at = NULL");
  const due = await claimDueJobs(10);
  assert.equal(due.length, 1);
  await resumeRunAfterWait(due[0].payload.runId);
  await markJobDone(due[0].id);

  const contact = await agent.get(`/api/contacts/${contactId}`);
  assert.ok(contact.body.tags.includes('retomou'), 'o passo depois do wait deveria ter rodado após a retomada');
});

test('opt-out: contato que manda PARAR não recebe mais mensagens automáticas', async () => {
  const sentTexts = [];
  installMockFetch(async (_url, opts) => {
    const payload = JSON.parse(opts.body);
    sentTexts.push(payload.text.body);
    return jsonResponse({ messages: [{ id: 'wamid.optout.' + sentTexts.length }] });
  });

  await agent.post('/api/automation-flows').send({
    name: 'Qualquer mensagem automática',
    trigger_type: 'keyword',
    trigger_config: { keyword: 'promo' },
    steps: [{ step_type: 'send_message', config: { text: 'Promoção especial pra você!' }, position: 0 }],
  });

  const { contactId } = await createConversationViaWebhook('5511500000004', 'oi');

  const body = inboundPayload({ waId: '5511500000004', text: 'PARAR' });
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 300));

  const contact = await agent.get(`/api/contacts/${contactId}`);
  // opted_out_at não vai no payload público de /contacts hoje — confirma via banco.
  const row = await query('SELECT opted_out_at FROM contacts WHERE id = $1', [contactId]);
  assert.ok(row.rows[0].opted_out_at, 'contato deveria estar marcado como opt-out');

  // Depois do opt-out, mesmo que a keyword "promo" apareça, não deveria mandar nada automático.
  const body2 = inboundPayload({ waId: '5511500000004', text: 'quero saber da promo' });
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body2)).send(body2);
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(!sentTexts.includes('Promoção especial pra você!'), 'não deveria ter mandado mensagem automática pro contato opt-out');
});

test('distribuição round-robin: alterna entre os participantes em ordem', async () => {
  const u1 = await createUser(tenantId, { name: 'RR 1', email: `rr1-${Date.now()}@tractom.com.br`, password: 'senha12345', role: 'atendente' });
  const u2 = await createUser(tenantId, { name: 'RR 2', email: `rr2-${Date.now()}@tractom.com.br`, password: 'senha12345', role: 'atendente' });

  const setup = await agent.put('/api/distribution-rule').send({ mode: 'round_robin', participant_user_ids: [u1.id, u2.id], is_active: true });
  assert.equal(setup.status, 200);

  await agent.post('/api/automation-flows').send({
    name: 'Round robin',
    trigger_type: 'first_message',
    steps: [{ step_type: 'assign_round_robin', config: {}, position: 0 }],
  });

  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.rr.' + Math.random() }] }));

  const conv1 = await createConversationViaWebhook('5511500000005', 'oi 1');
  const conv2 = await createConversationViaWebhook('5511500000006', 'oi 2');

  const d1 = await agent.get(`/api/conversations/${conv1.conversationId}`);
  const d2 = await agent.get(`/api/conversations/${conv2.conversationId}`);

  assert.notEqual(d1.body.assigned_user_id, d2.body.assigned_user_id, 'conversas consecutivas deveriam ir pra atendentes diferentes no round-robin');
  assert.ok([String(u1.id), String(u2.id)].includes(d1.body.assigned_user_id));
  assert.ok([String(u1.id), String(u2.id)].includes(d2.body.assigned_user_id));
});

test('gatilho stage_entered dispara automação ao mover de etapa', async () => {
  const funnelRes = await agent.post('/api/funnels').send({ name: 'Funil Gatilho Etapa' });
  const targetStage = funnelRes.body.stages[1];

  await agent.post('/api/automation-flows').send({
    name: 'Entrou em atendimento',
    trigger_type: 'stage_entered',
    trigger_config: { funnel_stage_id: targetStage.id },
    steps: [{ step_type: 'add_tag', config: { tag: 'em-atendimento-flag' }, position: 0 }],
  });

  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.stage.' + Math.random() }] }));
  const { conversationId, contactId } = await createConversationViaWebhook('5511500000007', 'oi');

  await agent.patch(`/api/conversations/${conversationId}/stage`).send({ funnel_stage_id: targetStage.id });
  await new Promise((r) => setTimeout(r, 300));

  const contact = await agent.get(`/api/contacts/${contactId}`);
  assert.ok(contact.body.tags.includes('em-atendimento-flag'), 'automação de stage_entered deveria ter rodado');
});
