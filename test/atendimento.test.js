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

// Fase 2 (núcleo): atribuição, status, prioridade, notas internas, janela de
// 24h, respostas rápidas, visibilidade de atendente.

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-fase2@tractom.com.br';
let app;
let adminAgent;
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
    await createUser(tenantId, { name: 'Admin Fase2', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
  }

  adminAgent = request.agent(app);
  const loginRes = await adminAgent.post('/api/auth/login').send({ email: ADMIN_EMAIL, password: 'senha-teste-123' });
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
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  return sig;
}

function inboundPayload({ waId, text = 'oi', msgId = 'wamid.' + Date.now() + Math.random() } = {}) {
  return {
    entry: [{ changes: [{ value: {
      messaging_product: 'whatsapp',
      contacts: [{ wa_id: waId, profile: { name: 'Cliente Fase2' } }],
      messages: [{ id: msgId, from: waId, type: 'text', text: { body: text } }],
    } }] }],
  };
}

async function createConversationViaWebhook(waId) {
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.auto.' + Math.random() }] }));
  const body = inboundPayload({ waId });
  await adminAgent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 300));
  const contacts = await adminAgent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === waId);
  const detail = await adminAgent.get(`/api/contacts/${contact.id}`);
  return detail.body.conversations[0].id;
}

test('atribuir conversa a mim mesmo (sem user_id) e depois desatribuir', async () => {
  const conversationId = await createConversationViaWebhook('5511700000001');

  const assignRes = await adminAgent.patch(`/api/conversations/${conversationId}/assign`).send({});
  assert.equal(assignRes.status, 200);
  assert.ok(assignRes.body.assigned_user_id);

  const unassignRes = await adminAgent.patch(`/api/conversations/${conversationId}/unassign`);
  assert.equal(unassignRes.status, 200);
  assert.equal(unassignRes.body.assigned_user_id, null);
});

test('fechar e reabrir conversa; reabre sozinha quando o contato manda mensagem de novo', async () => {
  const conversationId = await createConversationViaWebhook('5511700000002');

  const closeRes = await adminAgent.patch(`/api/conversations/${conversationId}/status`).send({ status: 'closed' });
  assert.equal(closeRes.status, 200);
  assert.equal(closeRes.body.status, 'closed');
  assert.ok(closeRes.body.closed_at);

  // Contato manda outra mensagem — deve reabrir sozinho (ver touchConversation).
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.reabre' }] }));
  const body = inboundPayload({ waId: '5511700000002', text: 'ainda preciso de ajuda', msgId: 'wamid.reabre.in' });
  await adminAgent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 300));

  const detail = await adminAgent.get(`/api/conversations/${conversationId}`);
  assert.equal(detail.body.status, 'open', 'conversa deveria ter reaberto sozinha');
  assert.equal(detail.body.closed_at, null);
});

test('marcar e desmarcar prioridade', async () => {
  const conversationId = await createConversationViaWebhook('5511700000003');

  const res = await adminAgent.patch(`/api/conversations/${conversationId}/priority`).send({ is_priority: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.is_priority, true);

  const res2 = await adminAgent.patch(`/api/conversations/${conversationId}/priority`).send({ is_priority: false });
  assert.equal(res2.body.is_priority, false);
});

test('nota interna nunca chama a Graph API e aparece com kind internal_note', async () => {
  const conversationId = await createConversationViaWebhook('5511700000004');

  const graphCalls = [];
  installMockFetch(async (url, opts) => {
    graphCalls.push({ url, opts });
    return jsonResponse({ messages: [{ id: 'nao-deveria-chamar' }] });
  });

  const res = await adminAgent.post(`/api/conversations/${conversationId}/notes`).send({ text: 'Cliente pediu desconto, verificar com gerente.' });
  assert.equal(res.status, 201);
  assert.equal(res.body.kind, 'internal_note');
  assert.equal(res.body.direction, 'outbound');

  assert.equal(graphCalls.length, 0, 'nota interna não deveria ter chamado a Graph API');

  const messages = await adminAgent.get(`/api/conversations/${conversationId}/messages`);
  assert.ok(messages.body.some((m) => m.kind === 'internal_note' && m.body.includes('desconto')));
});

test('janela de 24h: mensagem livre é recusada (422) se o contato não escreveu nas últimas 24h', async () => {
  const conversationId = await createConversationViaWebhook('5511700000005');

  // Força a conversa pra fora da janela (simula inatividade de 2 dias).
  await query("UPDATE conversations SET last_inbound_at = now() - interval '2 days' WHERE id = $1", [conversationId]);

  const res = await adminAgent.post(`/api/conversations/${conversationId}/messages`).send({ text: 'Oi, ainda aí?' });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'WINDOW_CLOSED');
});

test('janela de 24h: mensagem livre funciona normalmente logo após o contato escrever', async () => {
  const conversationId = await createConversationViaWebhook('5511700000006');
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.livre.1' }] }));

  const res = await adminAgent.post(`/api/conversations/${conversationId}/messages`).send({ text: 'Claro, me conta mais.' });
  assert.equal(res.status, 201);

  const detail = await adminAgent.get(`/api/conversations/${conversationId}`);
  assert.ok(detail.body.first_response_at, 'primeira resposta deveria ter sido registrada');
});

test('respostas rápidas: criar, listar, atalho duplicado é rejeitado', async () => {
  const create = await adminAgent.post('/api/quick-replies').send({ shortcut: 'ola', title: 'Saudação', body: 'Olá! Como posso ajudar?' });
  assert.equal(create.status, 201);

  const dup = await adminAgent.post('/api/quick-replies').send({ shortcut: 'ola', title: 'Outra', body: 'Oi' });
  assert.equal(dup.status, 409);

  const list = await adminAgent.get('/api/quick-replies');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
});

test('atendente só vê conversas atribuídas a ele + não atribuídas (RBAC de visibilidade)', async () => {
  const funnelRes = await adminAgent.post('/api/funnels').send({ name: 'Funil Visibilidade' });
  const funnelId = funnelRes.body.id;
  const stageId = funnelRes.body.stages[0].id;

  // Duas conversas no mesmo funil: uma vai ficar atribuída a OUTRO atendente, outra fica sem atribuição.
  const conv1 = await createConversationViaWebhook('5511700000007');
  const conv2 = await createConversationViaWebhook('5511700000008');
  await adminAgent.patch(`/api/conversations/${conv1}/funnel`).send({ funnel_id: funnelId, funnel_stage_id: stageId });
  await adminAgent.patch(`/api/conversations/${conv2}/funnel`).send({ funnel_id: funnelId, funnel_stage_id: stageId });

  const outroAtendenteEmail = `outro-atendente-${Date.now()}@tractom.com.br`;
  const meuEmail = `meu-atendente-${Date.now()}@tractom.com.br`;
  const outroUser = await createUser(tenantId, { name: 'Outro Atendente', email: outroAtendenteEmail, password: 'senha12345', role: 'atendente' });
  await createUser(tenantId, { name: 'Meu Atendente', email: meuEmail, password: 'senha12345', role: 'atendente' });

  await adminAgent.patch(`/api/conversations/${conv1}/assign`).send({ user_id: outroUser.id }); // atribuída a outro

  const atendenteAgent = request.agent(app);
  await atendenteAgent.post('/api/auth/login').send({ email: meuEmail, password: 'senha12345' });

  const res = await atendenteAgent.get(`/api/funnels/${funnelId}/conversations`);
  assert.equal(res.status, 200);
  const ids = res.body.map((c) => c.id);
  assert.ok(!ids.includes(conv1), 'não deveria ver a conversa atribuída a outro atendente');
  assert.ok(ids.includes(conv2), 'deveria ver a conversa não atribuída');
});
