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
const ADMIN_EMAIL = 'admin-aiagents@tractom.com.br';
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
    await createUser(tenantId, { name: 'Admin AI Agents', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
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
    contacts: [{ wa_id: waId, profile: { name: 'Cliente Agente ' + waId } }],
    messages: [{ id: 'wamid.' + waId + '.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text } }],
  } }] }] };
}

async function sendInbound(waId, text) {
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.out.' + Math.random() }] }));
  const body = inboundPayload(waId, text);
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 400));
}

test('CRUD de agente: criar, listar, editar, pausar/ativar e excluir', async () => {
  const created = await agent.post('/api/ai-agents').send({
    name: 'Suporte Pré-venda', system_prompt: 'Você é simpático.', keyword_regex: 'preço|valor',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.is_active, false);

  const listed = await agent.get('/api/ai-agents');
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].runs_today, 0);

  const activated = await agent.patch('/api/ai-agents/' + created.body.id + '/active').send({ is_active: true });
  assert.equal(activated.body.is_active, true);

  const edited = await agent.patch('/api/ai-agents/' + created.body.id).send({ name: 'Suporte Renomeado' });
  assert.equal(edited.body.name, 'Suporte Renomeado');

  const del = await agent.delete('/api/ai-agents/' + created.body.id);
  assert.equal(del.status, 204);
  const listedAfter = await agent.get('/api/ai-agents');
  assert.equal(listedAfter.body.length, 0);
});

test('duplicar agente cria uma cópia inativa com "(cópia)" no nome', async () => {
  const created = await agent.post('/api/ai-agents').send({ name: 'Original', system_prompt: 'oi' });
  const dup = await agent.post('/api/ai-agents/' + created.body.id + '/duplicate');
  assert.equal(dup.status, 201);
  assert.equal(dup.body.name, 'Original (cópia)');
  assert.equal(dup.body.is_active, false);
});

test('atendente não pode criar/editar/excluir agentes (RBAC)', async () => {
  const email = `atendente-aiagents-${Date.now()}@tractom.com.br`;
  await createUser(tenantId, { name: 'Atendente AI Agents', email, password: 'senha12345', role: 'atendente' });
  const atendenteAgent = request.agent(app);
  await atendenteAgent.post('/api/auth/login').send({ email, password: 'senha12345' });

  const res = await atendenteAgent.post('/api/ai-agents').send({ name: 'Tentativa', system_prompt: 'x' });
  assert.equal(res.status, 403);
});

test('agente ativo responde automaticamente (mock) e loga a execução', async () => {
  await agent.post('/api/ai-agents').send({ name: 'Bot Geral', system_prompt: 'Responda com simpatia.' })
    .then((r) => agent.patch('/api/ai-agents/' + r.body.id + '/active').send({ is_active: true }));

  await sendInbound('5511500000001', 'Olá, quero saber mais');

  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === '5511500000001');
  const detail = await agent.get('/api/contacts/' + contact.id);
  const convId = detail.body.conversations[0].id;
  const messages = await agent.get('/api/conversations/' + convId + '/messages');

  const automated = messages.body.find((m) => m.sender_type === 'automation');
  assert.ok(automated, 'deveria ter uma resposta automática do agente');
  assert.match(automated.body, /\[mock\]/);

  const runs = await query('SELECT outcome FROM ai_agent_runs');
  assert.equal(runs.rows.length, 1);
  assert.equal(runs.rows[0].outcome, 'replied');
});

test('mensagem com palavra-chave de handoff cria tarefa e marca prioridade, sem chamar a IA', async () => {
  const created = await agent.post('/api/ai-agents').send({
    name: 'Bot Handoff', system_prompt: 'x', handoff_keywords: ['falar com humano', 'atendente'],
  });
  await agent.patch('/api/ai-agents/' + created.body.id + '/active').send({ is_active: true });

  await sendInbound('5511500000002', 'quero falar com atendente agora');

  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === '5511500000002');
  const detail = await agent.get('/api/contacts/' + contact.id);
  const convId = detail.body.conversations[0].id;

  const conv = await agent.get('/api/conversations/' + convId);
  assert.equal(conv.body.is_priority, true);

  const tasks = await query('SELECT title FROM tasks WHERE conversation_id = $1', [convId]);
  assert.equal(tasks.rows.length, 1);
  assert.match(tasks.rows[0].title, /pediu atendente/);

  const runs = await query('SELECT outcome FROM ai_agent_runs');
  assert.equal(runs.rows[0].outcome, 'handoff');
});

test('agente com palavra-chave não casando não responde', async () => {
  const created = await agent.post('/api/ai-agents').send({ name: 'Bot Restrito', system_prompt: 'x', keyword_regex: 'orçamento' });
  await agent.patch('/api/ai-agents/' + created.body.id + '/active').send({ is_active: true });

  await sendInbound('5511500000003', 'oi, bom dia');

  const runs = await query('SELECT outcome FROM ai_agent_runs');
  assert.equal(runs.rows.length, 0);
});

test('agente fora do horário comercial configurado não responde', async () => {
  const now = new Date();
  const future = new Date(now.getTime() + 2 * 3600 * 1000);
  const startH = String(future.getUTCHours()).padStart(2, '0') + ':' + String(future.getUTCMinutes()).padStart(2, '0');
  const endFuture = new Date(future.getTime() + 3600 * 1000);
  const endH = String(endFuture.getUTCHours()).padStart(2, '0') + ':' + String(endFuture.getUTCMinutes()).padStart(2, '0');

  const created = await agent.post('/api/ai-agents').send({
    name: 'Bot Horario', system_prompt: 'x',
    business_hours_enabled: true, business_hours_start: startH, business_hours_end: endH, business_hours_tz: 'UTC',
  });
  await agent.patch('/api/ai-agents/' + created.body.id + '/active').send({ is_active: true });

  await sendInbound('5511500000004', 'oi');

  const runs = await query('SELECT outcome FROM ai_agent_runs');
  assert.equal(runs.rows.length, 0);
});
