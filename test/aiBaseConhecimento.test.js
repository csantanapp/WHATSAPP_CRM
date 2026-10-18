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
import { buildAgentSystemPrompt, parseAgentReply, isHumanRequest } from '../src/automation/agentPrompt.js';

// Agente de IA com base de conhecimento, agrupamento de rajadas e handoff.

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-kb@tractom.com.br';
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function leadSays(waId, text) {
  const body = { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name: 'Lead' } }],
    messages: [{ id: 'wamid.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text } }],
  } }] }] };
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(Buffer.from(JSON.stringify(body))).digest('hex');
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', sig).send(body);
  await sleep(200);
}

async function createAgent(fields) {
  const created = await agent.post('/api/ai-agents').send({ name: 'Sofia', system_prompt: 'Atenda com simpatia.', ...fields });
  await agent.patch('/api/ai-agents/' + created.body.id + '/active').send({ is_active: true });
  return created.body;
}

const convOf = async () => (await agent.get('/api/inbox/conversations?tab=all')).body[0];

test('prompt: base de conhecimento, regras de "só o que sabe" e marcadores', () => {
  const prompt = buildAgentSystemPrompt({
    name: 'Sofia', system_prompt: 'Fale de forma acolhedora.',
    knowledge_faq: [{ q: 'Valor do curso de Medicina?', a: 'R$ 890/mês' }],
    knowledge_text: 'Atendemos de segunda a sexta, 8h às 18h.',
    only_from_knowledge: true, allow_handoff: true,
  });
  assert.match(prompt, /Você é Sofia/);
  assert.match(prompt, /P: Valor do curso de Medicina\?\nR: R\$ 890\/mês/);
  assert.match(prompt, /segunda a sexta/);
  assert.match(prompt, /SOMENTE as informações da base/);
  assert.match(prompt, /\[\[HANDOFF\]\]/);
  assert.match(prompt, /\[\[SILENCIO\]\]/);

  const semHandoff = buildAgentSystemPrompt({ name: 'X', allow_handoff: false, only_from_knowledge: true, knowledge_text: 'a' });
  assert.doesNotMatch(semHandoff, /\[\[HANDOFF\]\]/);

  assert.deepEqual(parseAgentReply(' [[HANDOFF]] '), { kind: 'handoff' });
  assert.deepEqual(parseAgentReply('[[SILENCIO]]'), { kind: 'silence' });
  assert.deepEqual(parseAgentReply('Olá!'), { kind: 'reply', text: 'Olá!' });

  assert.ok(isHumanRequest('quero falar com um atendente'));
  assert.ok(!isHumanRequest('quero comprar para 2 pessoas'));
});

test('agrupa mensagens seguidas numa resposta só', async () => {
  await createAgent({ wait_seconds: 1 });
  await leadSays('5544933330001', 'oi');
  await leadSays('5544933330001', 'tudo bem?');
  await leadSays('5544933330001', 'quanto custa o curso?');
  assert.equal(sent.length, 0, 'ainda esperando o cliente terminar');
  await sleep(1400);
  assert.equal(sent.length, 1, 'uma resposta para as três mensagens');
  const runs = await query("SELECT outcome FROM ai_agent_runs");
  assert.deepEqual(runs.rows.map((r) => r.outcome), ['replied']);
});

test('pedido de humano: avisa o cliente, cria tarefa, pausa a IA na conversa; reativar volta a responder', async () => {
  await createAgent({ wait_seconds: 0, handoff_message: 'Já chamo alguém da equipe!' });
  await leadSays('5544933330002', 'quero falar com um atendente');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text.body, 'Já chamo alguém da equipe!');
  const conv = await convOf();
  const detail = (await agent.get(`/api/conversations/${conv.id}`)).body;
  assert.ok(detail.ai_paused_at);
  assert.equal(detail.ai_agents_active, true);
  assert.equal(detail.is_priority, true);
  assert.equal((await query('SELECT count(*)::int AS n FROM tasks')).rows[0].n, 1);

  await leadSays('5544933330002', 'oi?');
  assert.equal(sent.length, 1, 'IA pausada não responde');

  await agent.post(`/api/conversations/${conv.id}/ai`).send({ paused: false });
  await leadSays('5544933330002', 'ainda está aí?');
  assert.equal(sent.length, 2, 'IA reativada volta a responder');
});

test('atendente respondendo pelo CRM pausa a IA na conversa', async () => {
  await createAgent({ wait_seconds: 0 });
  await leadSays('5544933330003', 'oi');
  assert.equal(sent.length, 1);
  const conv = await convOf();

  const res = await agent.post(`/api/conversations/${conv.id}/messages`).send({ text: 'Oi! Aqui é a Ana.' });
  assert.equal(res.status, 201);
  const detail = (await agent.get(`/api/conversations/${conv.id}`)).body;
  assert.equal(detail.ai_paused_reason, 'Atendente assumiu a conversa');

  await leadSays('5544933330003', 'oi Ana');
  assert.equal(sent.length, 2, 'só a mensagem da atendente, nenhuma da IA');
});

test('em produção, sem chave de IA, o agente não manda resposta simulada ao cliente', async () => {
  await createAgent({ wait_seconds: 0 });
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await leadSays('5544933330004', 'oi');
  } finally {
    process.env.NODE_ENV = previous;
  }
  assert.equal(sent.length, 0);
  const runs = await query('SELECT outcome FROM ai_agent_runs');
  assert.equal(runs.rows[0].outcome, 'no_ai_key');
});

test('base de conhecimento é salva e devolvida pela API', async () => {
  const created = await agent.post('/api/ai-agents').send({
    name: 'KB', system_prompt: 'x',
    knowledge_faq: [{ q: 'Horário?', a: '8h às 18h' }, { q: '', a: 'descartado' }],
    knowledge_text: 'Endereço: Rua A, 10', only_from_knowledge: false, wait_seconds: 99,
  });
  const ag = (await agent.get('/api/ai-agents/' + created.body.id)).body;
  assert.deepEqual(ag.knowledge_faq, [{ q: 'Horário?', a: '8h às 18h' }]);
  assert.equal(ag.knowledge_text, 'Endereço: Rua A, 10');
  assert.equal(ag.only_from_knowledge, false);
  assert.equal(ag.wait_seconds, 60, 'limitado a 60s');
});
