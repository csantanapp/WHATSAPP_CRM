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

// Histórico de produtos de interesse do lead: manual, por formulário de
// automação e por oportunidade.

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-interesse@tractom.com.br';
let agent;
let sent;

before(async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'fake-token';
  const tenantId = await getDefaultTenantId();
  if (!(await findUserByEmail(tenantId, ADMIN_EMAIL))) {
    await createUser(tenantId, { name: 'Ana Admin', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
  }
  agent = request.agent(createApp());
  assert.equal((await agent.post('/api/auth/login').send({ email: ADMIN_EMAIL, password: 'senha-teste-123' })).status, 200);
});

beforeEach(async () => {
  await resetDb();
  await query('TRUNCATE opportunities RESTART IDENTITY CASCADE');
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

const createContact = async (waId) => (await agent.post('/api/contacts').send({ wa_id: waId, name: 'Maria' })).body;

test('manual: registra, não duplica o mesmo produto seguido e aparece na lista de Contatos', async () => {
  const c = await createContact('5544955580001');
  assert.equal((await agent.post(`/api/contacts/${c.id}/interests`).send({ product: '  Medicina ' })).status, 201);
  await agent.post(`/api/contacts/${c.id}/interests`).send({ product: 'medicina' }); // mesmo produto, mesmo dia
  await agent.post(`/api/contacts/${c.id}/interests`).send({ product: 'Enfermagem' });

  const list = (await agent.get(`/api/contacts/${c.id}/interests`)).body;
  assert.deepEqual(list.map((i) => i.product), ['Enfermagem', 'Medicina']);
  assert.equal(list[0].source, 'manual');
  assert.equal(list[0].created_by_name, 'Ana Admin');

  const row = (await agent.get('/api/contacts')).body.find((x) => x.id === c.id);
  assert.equal(row.latest_interest, 'Enfermagem');
  assert.deepEqual([...row.interests].sort(), ['Enfermagem', 'Medicina']);

  const products = (await agent.get('/api/interest-products')).body.map((p) => p.product).sort();
  assert.deepEqual(products, ['Enfermagem', 'Medicina']);

  assert.equal((await agent.post(`/api/contacts/${c.id}/interests`).send({ product: '   ' })).status, 400);
  assert.equal((await agent.delete(`/api/contact-interests/${list[0].id}`)).status, 204);
  assert.deepEqual((await agent.get(`/api/contacts/${c.id}/interests`)).body.map((i) => i.product), ['Medicina']);

  const history = (await agent.get(`/api/contacts/${c.id}/history`)).body;
  assert.ok(history.some((h) => h.type === 'interest' && h.description.includes('Medicina')));
});

test('formulário: pergunta com "registrar como produto de interesse" grava a opção escolhida', async () => {
  await agent.post('/api/automation-flows').send({
    name: 'Qualificação', trigger_type: 'keyword', trigger_config: { keyword: 'curso' },
    steps: [
      { client_id: 'q', step_type: 'ask_question', config: { text: 'Qual curso?', reply_type: 'numbered', options: ['Medicina', 'Enfermagem'], save_to: 'custom', custom_field: 'Curso', track_interest: true } },
    ],
  });
  await leadSays('5544955580002', 'quero um curso');
  await leadSays('5544955580002', '2');

  const contact = (await query(`SELECT id, custom_fields FROM contacts WHERE wa_id = '5544955580002'`)).rows[0];
  assert.equal(contact.custom_fields.Curso, 'Enfermagem', 'continua salvando no campo personalizado');
  const list = (await agent.get(`/api/contacts/${contact.id}/interests`)).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].product, 'Enfermagem');
  assert.equal(list[0].source, 'form');
  assert.equal(list[0].source_label, 'Qualificação');
});

test('formulário sem a opção ligada não registra interesse', async () => {
  await agent.post('/api/automation-flows').send({
    name: 'Só campo', trigger_type: 'keyword', trigger_config: { keyword: 'curso' },
    steps: [{ client_id: 'q', step_type: 'ask_question', config: { text: 'Qual curso?', reply_type: 'numbered', options: ['Medicina'], save_to: 'custom', custom_field: 'Curso' } }],
  });
  await leadSays('5544955580003', 'curso');
  await leadSays('5544955580003', '1');
  const n = (await query('SELECT count(*)::int AS n FROM contact_interests')).rows[0].n;
  assert.equal(n, 0);
});

test('oportunidade criada entra no histórico de interesse', async () => {
  const c = await createContact('5544955580004');
  const res = await agent.post('/api/opportunities').send({ contact_id: c.id, title: 'Curso de Medicina — turma 2027', value: 4500 });
  assert.equal(res.status, 201);
  const list = (await agent.get(`/api/contacts/${c.id}/interests`)).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].product, 'Curso de Medicina — turma 2027');
  assert.equal(list[0].source, 'opportunity');
});
