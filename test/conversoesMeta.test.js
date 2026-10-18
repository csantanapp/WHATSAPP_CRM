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
import { setSetting } from '../src/repositories/settings.js';

// Conversions API da Meta (business_messaging).

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-capi@tractom.com.br';
let agent;
let capiCalls;
let capiResponse;

before(async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'fake-token';
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = 'WABA123';
  const tenantId = await getDefaultTenantId();
  if (!(await findUserByEmail(tenantId, ADMIN_EMAIL))) {
    await createUser(tenantId, { name: 'Admin', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
  }
  agent = request.agent(createApp());
  assert.equal((await agent.post('/api/auth/login').send({ email: ADMIN_EMAIL, password: 'senha-teste-123' })).status, 200);
});

beforeEach(async () => {
  await resetDb();
  await query("DELETE FROM app_settings WHERE key LIKE 'capi_%'");
  capiCalls = [];
  capiResponse = () => jsonResponse({ events_received: 1, fbtrace_id: 'TRACE1' });
  installMockFetch(async (url, opts) => {
    if (String(url).endsWith('/events')) {
      capiCalls.push({ url: String(url), body: JSON.parse(opts.body) });
      return capiResponse();
    }
    return jsonResponse({ messages: [{ id: 'wamid.out.' + Math.random() }] });
  });
});

after(async () => {
  restoreFetch();
  await closeDb();
});

async function leadSays(waId, text, referral) {
  const body = { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name: 'Lead ' + waId.slice(-2) } }],
    messages: [{ id: 'wamid.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text }, ...(referral ? { referral } : {}) }],
  } }] }] };
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(Buffer.from(JSON.stringify(body))).digest('hex');
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', sig).send(body);
  await new Promise((r) => setTimeout(r, 250));
  const list = (await agent.get('/api/inbox/conversations?tab=all')).body;
  return list.find((c) => c.phone_display === waId) || list[0];
}

const AD = { source_type: 'ad', source_id: '999', headline: 'Curso', ctwa_clid: 'CLID-REAL-1' };

async function setup({ enabled = true, dataset = 'DS1' } = {}) {
  await setSetting('capi_enabled', enabled ? 'true' : 'false');
  await setSetting('capi_dataset_id', dataset);
  await agent.post('/api/funnels').send({ name: 'Vendas' });
  const funnels = (await agent.get('/api/funnels')).body;
  const stages = funnels[0].stages;
  await agent.patch(`/api/stages/${stages[1].id}`).send({ meta_event: 'QualifiedLead' });
  await agent.patch(`/api/stages/${stages[3].id}`).send({ meta_event: 'Purchase' });
  return { qualified: stages[1], won: stages[3], other: stages[2] };
}

async function waitEvents(n) {
  for (let i = 0; i < 40; i++) {
    const rows = (await query("SELECT * FROM conversion_events WHERE status <> 'pending' ORDER BY id")).rows;
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return (await query('SELECT * FROM conversion_events ORDER BY id')).rows;
}

test('lead de anúncio entra na etapa "qualificado": envia QualifiedLead uma vez só', async () => {
  const conv = await leadSays('5544922220001', 'Oi', AD);
  const { qualified, other } = await setup();

  await agent.patch(`/api/conversations/${conv.id}/stage`).send({ funnel_stage_id: qualified.id });
  const [ev] = await waitEvents(1);
  assert.equal(ev.status, 'sent');
  assert.equal(ev.fbtrace_id, 'TRACE1');

  assert.equal(capiCalls.length, 1);
  assert.match(capiCalls[0].url, /\/DS1\/events$/);
  const sentEvent = capiCalls[0].body.data[0];
  assert.equal(sentEvent.event_name, 'QualifiedLead');
  assert.equal(sentEvent.action_source, 'business_messaging');
  assert.equal(sentEvent.messaging_channel, 'whatsapp');
  assert.deepEqual(sentEvent.user_data, { ctwa_clid: 'CLID-REAL-1', whatsapp_business_account_id: 'WABA123' });
  assert.deepEqual(sentEvent.custom_data, { lead_stage: 'qualified' });
  assert.ok(!JSON.stringify(capiCalls[0].body).includes('5544922220001'), 'telefone nunca vai pra Meta');

  // Sai e volta pra etapa: não reenvia.
  await agent.patch(`/api/conversations/${conv.id}/stage`).send({ funnel_stage_id: other.id });
  await agent.patch(`/api/conversations/${conv.id}/stage`).send({ funnel_stage_id: qualified.id });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(capiCalls.length, 1);
});

test('oportunidade ganha envia Purchase com o valor; etapa de venda depois não duplica', async () => {
  const conv = await leadSays('5544922220002', 'Quero comprar', AD);
  const { won } = await setup();
  const detail = (await agent.get(`/api/conversations/${conv.id}`)).body;
  const opp = (await agent.post('/api/opportunities').send({ contact_id: detail.contact_id, conversation_id: conv.id, title: 'Curso Medicina', value: 4500 })).body;

  await agent.post(`/api/opportunities/${opp.id}/won`).send({});
  const [ev] = await waitEvents(1);
  assert.equal(ev.event_name, 'Purchase');
  assert.equal(ev.status, 'sent');
  assert.deepEqual(capiCalls[0].body.data[0].custom_data, { lead_stage: 'won', value: 4500, currency: 'BRL' });

  await agent.patch(`/api/conversations/${conv.id}/stage`).send({ funnel_stage_id: won.id });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(capiCalls.length, 1, 'mesma conversa não gera segunda venda');
});

test('lead sem anúncio fica "não enviado" com o motivo; Meta descartando vira "falhou"', async () => {
  const direct = await leadSays('5544922220003', 'Oi, vim direto');
  const { qualified } = await setup();
  await agent.patch(`/api/conversations/${direct.id}/stage`).send({ funnel_stage_id: qualified.id });
  const [skipped] = await waitEvents(1);
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.error, /não veio de um anúncio/);
  assert.equal(capiCalls.length, 0);

  capiResponse = () => jsonResponse({ events_received: 0, fbtrace_id: 'T0' });
  const fromAd = await leadSays('5544922220004', 'Oi', { ...AD, ctwa_clid: 'CLID-2' });
  await agent.patch(`/api/conversations/${fromAd.id}/stage`).send({ funnel_stage_id: qualified.id });
  const rows = await waitEvents(2);
  const failed = rows.find((r) => r.conversation_id === String(fromAd.id) || r.conversation_id === fromAd.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /descartou o evento/);
});

test('desligado não registra nada; meta_event inválido é recusado', async () => {
  const conv = await leadSays('5544922220005', 'Oi', AD);
  const { qualified } = await setup({ enabled: false });
  await agent.patch(`/api/conversations/${conv.id}/stage`).send({ funnel_stage_id: qualified.id });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await query('SELECT count(*)::int AS n FROM conversion_events')).rows[0].n, 0);
  assert.equal(capiCalls.length, 0);

  const bad = await agent.patch(`/api/stages/${qualified.id}`).send({ meta_event: 'Inventado' });
  assert.equal(bad.status, 400);

  const settings = (await agent.get('/api/settings/meta-conversions')).body;
  assert.equal(settings.enabled, false);
  assert.equal(settings.datasetId, 'DS1');
});
