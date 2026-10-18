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

// Nó "Conectar Agente IA" (start_ai_agent): o fluxo termina e um agente de IA
// passa a atender a conversa, mesmo fora dos gatilhos dele.

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-conectar-agente@tractom.com.br';
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
  await query('TRUNCATE ai_agents, ai_agent_runs, tasks RESTART IDENTITY CASCADE');
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

async function leadSays(waId, text) {
  const body = { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name: 'Lead' } }],
    messages: [{ id: 'wamid.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text } }],
  } }] }] };
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(Buffer.from(JSON.stringify(body))).digest('hex');
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', sig).send(body);
  await new Promise((r) => setTimeout(r, 250));
}
const texts = () => sent.map((m) => m.text?.body).filter(Boolean);
const agentReplies = () => texts().filter((t) => t.startsWith('[mock]'));

// Agente que normalmente NUNCA responderia (palavra-chave que não casa).
async function createAgent() {
  const created = await agent.post('/api/ai-agents').send({
    name: 'Sofia', system_prompt: 'Atenda com simpatia.', keyword_regex: 'zzz-nunca-casa', wait_seconds: 0,
  });
  await agent.patch('/api/ai-agents/' + created.body.id + '/active').send({ is_active: true });
  return created.body;
}
async function createFlow(agentId, replyNow = true) {
  const res = await agent.post('/api/automation-flows').send({
    name: 'Boas-vindas', trigger_type: 'keyword', trigger_config: { keyword: 'curso' },
    steps: [
      { client_id: 'm', step_type: 'send_message', config: { text: 'Olá! Vou te passar para a Sofia.' }, next_step_id: 'ia' },
      { client_id: 'ia', step_type: 'start_ai_agent', config: { agent_id: agentId, reply_now: replyNow } },
    ],
  });
  assert.equal(res.status, 201);
  return res.body;
}

test('fluxo conecta o agente: ele responde na hora e continua atendendo as próximas mensagens', async () => {
  const sofia = await createAgent();
  const flow = await createFlow(sofia.id);

  await leadSays('5544955570001', 'quero o curso');
  assert.equal(texts()[0], 'Olá! Vou te passar para a Sofia.');
  assert.equal(agentReplies().length, 1, 'responde já, sem esperar a próxima mensagem');

  const conv = (await query('SELECT id, ai_agent_id FROM conversations')).rows[0];
  assert.equal(String(conv.ai_agent_id), String(sofia.id));
  const run = (await query('SELECT status FROM automation_runs')).rows[0];
  assert.equal(run.status, 'completed');

  // A palavra-chave do agente não casa, mas ele foi conectado pelo fluxo.
  await leadSays('5544955570001', 'e qual o preço?');
  assert.equal(agentReplies().length, 2);

  const detail = (await agent.get('/api/conversations/' + conv.id)).body;
  assert.equal(detail.ai_agent_name, 'Sofia');

  const step = flow.steps.find((s) => s.step_type === 'start_ai_agent');
  const log = await query('SELECT outcome FROM automation_step_logs WHERE step_id = $1', [step.id]);
  assert.deepEqual(log.rows.map((r) => r.outcome), ['connected']);
});

test('"Responder já" desligado: o agente só responde a próxima mensagem', async () => {
  const sofia = await createAgent();
  await createFlow(sofia.id, false);

  await leadSays('5544955570002', 'quero o curso');
  assert.equal(agentReplies().length, 0);

  await leadSays('5544955570002', 'tenho uma dúvida');
  assert.equal(agentReplies().length, 1);
});

test('conectar reativa a IA pausada; pedido de humano pausa de novo normalmente', async () => {
  const sofia = await createAgent();
  await createFlow(sofia.id);
  await leadSays('5544955570003', 'oi');
  await query(`UPDATE conversations SET ai_paused_at = now(), ai_paused_reason = 'Atendente assumiu'`);

  await leadSays('5544955570003', 'quero o curso');
  assert.equal(agentReplies().length, 1);
  assert.equal((await query('SELECT ai_paused_at FROM conversations')).rows[0].ai_paused_at, null);

  await leadSays('5544955570003', 'quero falar com um atendente');
  assert.ok((await query('SELECT ai_paused_at FROM conversations')).rows[0].ai_paused_at, 'handoff pausa a IA');
  const before = agentReplies().length;
  await leadSays('5544955570003', 'alô?');
  assert.equal(agentReplies().length, before, 'com a IA pausada o agente não responde');
});

test('agente pausado ou não escolhido: o fluxo só termina e ninguém responde', async () => {
  const sofia = await createAgent();
  await agent.patch('/api/ai-agents/' + sofia.id + '/active').send({ is_active: false });
  await createFlow(sofia.id);
  await leadSays('5544955570004', 'quero o curso');
  assert.deepEqual(texts(), ['Olá! Vou te passar para a Sofia.']);
  assert.equal((await query('SELECT ai_agent_id FROM conversations')).rows[0].ai_agent_id, null);

  sent = [];
  await resetDb();
  await query('TRUNCATE ai_agents, ai_agent_runs RESTART IDENTITY CASCADE');
  await createFlow(null);
  await leadSays('5544955570005', 'quero o curso');
  assert.deepEqual(texts(), ['Olá! Vou te passar para a Sofia.']);
});
