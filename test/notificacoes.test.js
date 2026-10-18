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

// Sino de notificações: novo lead, pedido de humano, conversa e lembrete
// atribuídos — cada usuário vê só as dele e ninguém é avisado do que fez.

const APP_SECRET = 'test-secret';
const ADMIN = { email: 'admin-notif@tractom.com.br', name: 'Ana Admin' };
const SELLER = { email: 'vendedor-notif@tractom.com.br', name: 'Vitor Vendedor' };
let admin;
let seller;
let adminId;
let sellerId;

async function loginAs(u) {
  const tenantId = await getDefaultTenantId();
  let user = await findUserByEmail(tenantId, u.email);
  if (!user) user = await createUser(tenantId, { name: u.name, email: u.email, password: 'senha-teste-123', role: 'admin' });
  const ag = request.agent(createApp());
  assert.equal((await ag.post('/api/auth/login').send({ email: u.email, password: 'senha-teste-123' })).status, 200);
  return { ag, id: Number(user.id) };
}

before(async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'fake-token';
  ({ ag: admin, id: adminId } = await loginAs(ADMIN));
  ({ ag: seller, id: sellerId } = await loginAs(SELLER));
  // Só os dois usuários deste teste ficam ativos (o "todos" fica previsível).
  await query(`UPDATE users SET status = 'disabled' WHERE id <> ALL($1::bigint[])`, [[adminId, sellerId]]);
});

beforeEach(async () => {
  await resetDb();
  await query('TRUNCATE notifications, ai_agents, ai_agent_runs, tasks RESTART IDENTITY CASCADE');
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.out.' + Date.now() }] }));
});

after(async () => {
  await query(`UPDATE users SET status = 'active'`);
  restoreFetch();
  await closeDb();
});

async function leadSays(waId, text, name = 'Lead Teste') {
  const body = { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name } }],
    messages: [{ id: 'wamid.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text } }],
  } }] }] };
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(Buffer.from(JSON.stringify(body))).digest('hex');
  await admin.post('/webhook/whatsapp').set('x-hub-signature-256', sig).send(body);
  await new Promise((r) => setTimeout(r, 250));
}
const notifsOf = async (ag) => (await ag.get('/api/notifications')).body;
const convId = async () => (await query('SELECT id FROM conversations ORDER BY id DESC LIMIT 1')).rows[0].id;

test('novo lead avisa todos os usuários ativos; marcar como lida é por usuário', async () => {
  await leadSays('5544955590001', 'oi', 'Carla Lima');
  const a = await notifsOf(admin);
  const s = await notifsOf(seller);
  assert.equal(a.unread, 1);
  assert.equal(s.unread, 1);
  assert.equal(a.items[0].type, 'new_lead');
  assert.equal(a.items[0].title, 'Novo lead: Carla Lima');
  assert.equal(a.items[0].body, 'Chegou pelo WhatsApp');

  // A mesma conversa escrevendo de novo não gera outro "novo lead".
  await leadSays('5544955590001', 'tem alguém aí?', 'Carla Lima');
  assert.equal((await notifsOf(admin)).unread, 1);

  assert.equal((await admin.post(`/api/notifications/${a.items[0].id}/read`)).status, 204);
  assert.equal((await notifsOf(admin)).unread, 0);
  assert.equal((await notifsOf(seller)).unread, 1, 'a leitura de um não marca a do outro');
  // Ninguém marca a notificação de outro usuário.
  assert.equal((await admin.post(`/api/notifications/${s.items[0].id}/read`)).status, 404);
});

test('conversa atribuída avisa só quem recebeu; assumir pra si não avisa', async () => {
  await leadSays('5544955590002', 'oi', 'Bruno');
  await admin.post('/api/notifications/read-all');
  await seller.post('/api/notifications/read-all');
  const id = await convId();

  await admin.patch(`/api/conversations/${id}/assign`).send({ user_id: sellerId });
  const s = await notifsOf(seller);
  assert.equal(s.unread, 1);
  assert.equal(s.items[0].type, 'assigned');
  assert.equal(s.items[0].title, 'Conversa atribuída a você: Bruno');
  assert.equal(s.items[0].body, 'Atribuída por Ana Admin');
  assert.equal((await notifsOf(admin)).unread, 0);

  // Reatribuir pra mesma pessoa não avisa de novo; "Assumir" (pra si) não avisa.
  await admin.patch(`/api/conversations/${id}/assign`).send({ user_id: sellerId });
  await admin.patch(`/api/conversations/${id}/assign`).send({});
  assert.equal((await notifsOf(seller)).unread, 1);
  assert.equal((await notifsOf(admin)).unread, 0);

  // Abrir a conversa marca as notificações dela como lidas.
  await seller.post(`/api/conversations/${id}/notifications/read`);
  assert.equal((await notifsOf(seller)).unread, 0);
});

test('lembrete criado pra outra pessoa avisa; pra si mesmo não', async () => {
  await admin.post('/api/tasks').send({ title: 'Ligar pro lead', assigned_user_id: sellerId, due_at: '2030-05-10T15:00:00Z' });
  await admin.post('/api/tasks').send({ title: 'Meu lembrete' });
  const s = await notifsOf(seller);
  assert.equal(s.unread, 1);
  assert.equal(s.items[0].type, 'task');
  assert.equal(s.items[0].title, 'Novo lembrete: Ligar pro lead');
  assert.match(s.items[0].body, /^Para 10\/05/);
  assert.equal((await notifsOf(admin)).unread, 0);
});

test('lead pedindo atendente humano à IA avisa a equipe', async () => {
  const created = await admin.post('/api/ai-agents').send({ name: 'Sofia', system_prompt: 'Atenda.', wait_seconds: 0 });
  await admin.patch('/api/ai-agents/' + created.body.id + '/active').send({ is_active: true });
  await leadSays('5544955590003', 'oi', 'Diego');
  await admin.post('/api/notifications/read-all');
  await seller.post('/api/notifications/read-all');

  await leadSays('5544955590003', 'quero falar com um atendente', 'Diego');
  for (const ag of [admin, seller]) {
    const n = await notifsOf(ag);
    assert.equal(n.unread, 1);
    assert.equal(n.items[0].type, 'ai_handoff');
    assert.equal(n.items[0].title, 'Diego quer falar com uma pessoa');
  }
});
