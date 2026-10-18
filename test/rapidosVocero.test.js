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

// Origem do anúncio no Inbox, contato "só humano" e status de entrega.

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-rapidos@tractom.com.br';
let agent;
let sent;

before(async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'fake-token';
  const app = createApp();
  const tenantId = await getDefaultTenantId();
  if (!(await findUserByEmail(tenantId, ADMIN_EMAIL))) {
    await createUser(tenantId, { name: 'Admin', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
  }
  agent = request.agent(app);
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

function leadSays(waId, text, extra = {}) {
  return webhook({
    contacts: [{ wa_id: waId, profile: { name: 'Lead' } }],
    messages: [{ id: 'wamid.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text }, ...extra }],
  });
}

test('conversa vinda de anúncio aparece com a origem e no filtro "Anúncios"', async () => {
  await leadSays('5544911110001', 'Quero saber mais', {
    referral: {
      source_url: 'https://fb.me/abc', source_id: '120200', source_type: 'ad',
      headline: 'Curso de Medicina 2026', body: 'Inscrições abertas', media_type: 'image',
      image_url: 'https://cdn.example/creative.jpg', ctwa_clid: 'clid123',
    },
  });
  await leadSays('5544911110002', 'Oi, vim direto');

  const all = (await agent.get('/api/inbox/conversations?tab=all')).body;
  assert.equal(all.length, 2);
  const fromAd = all.find((c) => c.source_type === 'referral_ad');
  assert.equal(fromAd.ad_headline, 'Curso de Medicina 2026');
  assert.equal(fromAd.ad_source_kind, 'ad');

  const adsOnly = (await agent.get('/api/inbox/conversations?tab=all&ads=true')).body;
  assert.deepEqual(adsOnly.map((c) => c.id), [fromAd.id]);

  const src = (await agent.get(`/api/conversations/${fromAd.id}/source`)).body;
  assert.equal(src.raw.image_url, 'https://cdn.example/creative.jpg');
  assert.equal(src.source_url, 'https://fb.me/abc');
});

test('contato "só humano": fluxo e IA não respondem; reativar volta ao normal', async () => {
  await agent.post('/api/automation-flows').send({
    name: 'Curso', trigger_type: 'keyword', trigger_config: { keyword: 'curso' },
    steps: [{ client_id: 'a', step_type: 'ask_question', config: { text: 'Qual curso?' } }],
  });
  const ai = await agent.post('/api/ai-agents').send({ name: 'IA', system_prompt: 'Ajude.' });
  await agent.patch(`/api/ai-agents/${ai.body.id}/active`).send({ is_active: true });

  const waId = '5544911110010';
  await leadSays(waId, 'oi');
  sent = [];
  const contact = (await agent.get('/api/contacts')).body.find((c) => c.wa_id === waId);

  const paused = await agent.patch(`/api/contacts/${contact.id}`).send({ bot_paused: true });
  assert.equal(paused.body.bot_paused, true);

  await leadSays(waId, 'quero o curso');
  assert.equal(sent.length, 0, 'nem o fluxo nem a IA respondem contato só humano');
  const list = (await agent.get('/api/inbox/conversations?tab=all')).body;
  assert.equal(list[0].bot_paused, true);
  assert.equal((await agent.get(`/api/conversations/${list[0].id}`)).body.contact_bot_paused, true);

  await agent.patch(`/api/contacts/${contact.id}`).send({ bot_paused: false });
  await leadSays(waId, 'curso de novo');
  assert.equal(sent[0].text.body, 'Qual curso?');

  const history = (await agent.get(`/api/contacts/${contact.id}/history`)).body.map((h) => h.description);
  assert.ok(history.some((d) => d.includes('Atendimento só humano')));
  assert.ok(history.some((d) => d.includes('reativadas')));
});

test('status de entrega só avança e guarda o motivo da falha', async () => {
  await leadSays('5544911110020', 'oi');
  const conv = (await agent.get('/api/inbox/conversations?tab=all')).body[0];
  await query(
    `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, body, status)
     VALUES ($1,'wamid.A','outbound','agent','olá','sent'), ($1,'wamid.B','outbound','agent','oi?','sent')`,
    [conv.id]
  );
  const statusOf = async (id) => (await query('SELECT status, error_message FROM messages WHERE wa_message_id = $1', [id])).rows[0];

  await webhook({ statuses: [{ id: 'wamid.A', status: 'read' }] });
  await webhook({ statuses: [{ id: 'wamid.A', status: 'delivered' }] }); // chegou atrasado
  await webhook({ statuses: [{ id: 'wamid.A', status: 'failed', errors: [{ code: 1, message: 'x' }] }] });
  assert.deepEqual(await statusOf('wamid.A'), { status: 'read', error_message: null });

  await webhook({ statuses: [{ id: 'wamid.B', status: 'failed', errors: [{ code: 131030, title: 'Recipient not allowed', error_data: { details: 'Número fora da lista' } }] }] });
  await webhook({ statuses: [{ id: 'wamid.B', status: 'sent' }] });
  assert.deepEqual(await statusOf('wamid.B'), { status: 'failed', error_message: 'Número fora da lista' });
});
