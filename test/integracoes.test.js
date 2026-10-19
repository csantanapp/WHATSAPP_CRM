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

// Integrações: ChatGPT e Claude conectados ao mesmo tempo; Google Sheets com
// "Conectar conta Google", blocos Salvar/Buscar e envio de contato novo.

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-integracoes@tractom.com.br';
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
let agent;
let calls;
let sheet; // planilha falsa: { NomeDaAba: [[cabeçalhos], [linha], ...] }
let whatsappSent;

function fakeSheetsResponse(url, opts) {
  const u = new URL(url);
  const method = (opts?.method || 'GET').toUpperCase();
  if (!u.pathname.includes('/values/')) {
    return jsonResponse({ properties: { title: 'Leads chattrack' }, sheets: Object.keys(sheet).map((t) => ({ properties: { title: t } })) });
  }
  const rangeRaw = decodeURIComponent(u.pathname.split('/values/')[1]).replace(/:append$/, '');
  const m = rangeRaw.match(/^'(.*)'!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
  const tab = m[1].replace(/''/g, "'");
  sheet[tab] = sheet[tab] || [];
  if (method === 'GET') return jsonResponse({ values: sheet[tab] });
  const values = JSON.parse(opts.body).values;
  if (u.pathname.endsWith(':append')) {
    sheet[tab].push(values[0]);
  } else {
    const rowIndex = Number(m[3] || 1) - 1;
    sheet[tab][rowIndex] = values[0];
  }
  return jsonResponse({});
}

before(async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'fake-token';
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
  const tenantId = await getDefaultTenantId();
  if (!(await findUserByEmail(tenantId, ADMIN_EMAIL))) {
    await createUser(tenantId, { name: 'Admin', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
  }
  agent = request.agent(createApp());
  assert.equal((await agent.post('/api/auth/login').send({ email: ADMIN_EMAIL, password: 'senha-teste-123' })).status, 200);
});

beforeEach(async () => {
  await resetDb();
  await query('TRUNCATE ai_provider_keys, google_connections, google_sheets, ai_agents, ai_agent_runs RESTART IDENTITY CASCADE');
  await query(`UPDATE ai_settings SET provider = 'mock', api_key_encrypted = NULL`);
  calls = [];
  whatsappSent = [];
  sheet = { Contatos: [] };
  installMockFetch(async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts });
    if (u.startsWith('https://api.openai.com')) return jsonResponse({ choices: [{ message: { content: 'ok do ChatGPT' } }], usage: {} });
    if (u.startsWith('https://api.anthropic.com')) return jsonResponse({ content: [{ text: 'ok do Claude' }], usage: {} });
    if (u.startsWith('https://oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'ya29.fake', refresh_token: '1//refresh', expires_in: 3600 });
    if (u.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) return jsonResponse({ email: 'marketing@empresa.com' });
    if (u.startsWith('https://sheets.googleapis.com')) return fakeSheetsResponse(u, opts);
    whatsappSent.push(JSON.parse(opts.body));
    return jsonResponse({ messages: [{ id: 'wamid.out.' + calls.length }] });
  });
});

after(async () => {
  restoreFetch();
  await closeDb();
});

async function leadSays(waId, text, name = 'Lead') {
  const body = { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name } }],
    messages: [{ id: 'wamid.' + Date.now() + Math.random(), from: waId, type: 'text', text: { body: text } }],
  } }] }] };
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(Buffer.from(JSON.stringify(body))).digest('hex');
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', sig).send(body);
  await new Promise((r) => setTimeout(r, 300));
}

async function connectGoogle() {
  assert.equal((await agent.put('/api/integrations/google/client').send({ client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-segredo-teste' })).status, 204);
  const { url } = (await agent.post('/api/integrations/google/connect')).body;
  const state = new URL(url).searchParams.get('state');
  const cb = await agent.get('/api/integrations/google/callback').query({ code: 'codigo-google', state });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.location, '/?integracao=google_ok&msg=' + encodeURIComponent('marketing@empresa.com'));
  return (await agent.post('/api/integrations/google/sheets').send({ url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0` })).body;
}

test('ChatGPT e Claude conectados ao mesmo tempo; cada agente usa a própria chave', async () => {
  let ai = (await agent.put('/api/integrations/ai/openai').send({ api_key: 'sk-openai-teste' })).body;
  assert.equal(ai.find((p) => p.provider === 'openai').is_default, true, 'primeiro conectado vira o padrão');
  ai = (await agent.put('/api/integrations/ai/anthropic').send({ api_key: 'sk-ant-teste', model: 'claude-haiku-5-5' })).body;
  assert.ok(ai.find((p) => p.provider === 'anthropic').connected);
  assert.equal(ai.find((p) => p.provider === 'openai').is_default, true, 'conectar outro não troca o padrão');
  assert.equal(JSON.stringify(ai).includes('sk-'), false, 'a chave nunca volta pro navegador');

  const test1 = (await agent.post('/api/integrations/ai/anthropic/test')).body;
  assert.equal(test1.ok, true);
  const anthropicCall = calls.find((c) => c.url.startsWith('https://api.anthropic.com'));
  assert.equal(anthropicCall.opts.headers['x-api-key'], 'sk-ant-teste');
  assert.equal(JSON.parse(anthropicCall.opts.body).model, 'claude-haiku-5-5');

  // Agente com provedor Claude enquanto o padrão é o ChatGPT.
  const a = (await agent.post('/api/ai-agents').send({ name: 'Sofia', system_prompt: 'Atenda.', provider: 'anthropic', wait_seconds: 0 })).body;
  await agent.patch('/api/ai-agents/' + a.id + '/active').send({ is_active: true });
  calls = [];
  await leadSays('5544955600001', 'oi, tudo bem?');
  assert.ok(calls.some((c) => c.url.startsWith('https://api.anthropic.com')), 'agente usou o Claude');
  assert.equal(whatsappSent.at(-1).text.body, 'ok do Claude');

  ai = (await agent.delete('/api/integrations/ai/openai')).body;
  assert.equal(ai.find((p) => p.provider === 'anthropic').is_default, true, 'ao remover o padrão, o outro conectado assume');
});

test('Conectar conta Google: estado inválido é recusado; conexão guarda o e-mail e a planilha', async () => {
  await agent.put('/api/integrations/google/client').send({ client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-segredo-teste' });
  const bad = await agent.get('/api/integrations/google/callback').query({ code: 'x', state: 'forjado' });
  assert.match(bad.headers.location, /google_erro/);
  assert.equal((await agent.put('/api/integrations/google/client').send({ client_id: 'qualquer', client_secret: 'x' })).status, 400);

  const added = await connectGoogle();
  assert.equal(added.title, 'Leads chattrack');
  assert.deepEqual(added.tabs, ['Contatos']);
  const info = (await agent.get('/api/integrations')).body.google;
  assert.equal(info.connected, true);
  assert.equal(info.email, 'marketing@empresa.com');
  assert.equal(info.sheets.length, 1);
  const stored = (await query('SELECT refresh_token_encrypted FROM google_connections')).rows[0].refresh_token_encrypted;
  assert.notEqual(stored, '1//refresh', 'refresh token fica criptografado');
});

test('bloco "Salvar no Google Sheets" cria cabeçalhos, adiciona e não duplica o mesmo lead', async () => {
  const s = await connectGoogle();
  sheet.Contatos = [['Nome', 'Telefone']];
  await agent.post('/api/automation-flows').send({
    name: 'Planilha', trigger_type: 'keyword', trigger_config: { keyword: 'curso' },
    steps: [
      { client_id: 'q', step_type: 'ask_question', config: { text: 'Qual curso?', save_to: 'custom', custom_field: 'Curso' }, next_step_id: 'g' },
      { client_id: 'g', step_type: 'sheets_save', config: {
        sheet_id: s.id, tab: 'Contatos', match_column: 'Telefone',
        columns: [{ header: 'Nome', value: '{{nome}}' }, { header: 'Telefone', value: '{{telefone}}' }, { header: 'Curso', value: '{{Curso}}' }, { header: 'Canal', value: '{{canal}}' }],
      }, next_step_id: 'm' },
      { client_id: 'm', step_type: 'send_message', config: { text: 'Anotado!' } },
    ],
  });
  await leadSays('5544955600002', 'quero um curso', 'Maria Souza');
  await leadSays('5544955600002', 'Medicina', 'Maria Souza');
  assert.deepEqual(sheet.Contatos[0], ['Nome', 'Telefone', 'Curso', 'Canal'], 'cabeçalhos que faltavam foram criados');
  assert.equal(sheet.Contatos.length, 2);
  assert.equal(sheet.Contatos[1][0], 'Maria Souza');
  assert.equal(sheet.Contatos[1][2], 'Medicina');
  assert.equal(sheet.Contatos[1][3], 'WhatsApp');
  assert.equal(whatsappSent.at(-1).text.body, 'Anotado!');

  // Mesmo lead de novo: atualiza a linha em vez de criar outra.
  await leadSays('5544955600002', 'quero outro curso', 'Maria Souza');
  await leadSays('5544955600002', 'Enfermagem', 'Maria Souza');
  assert.equal(sheet.Contatos.length, 2);
  assert.equal(sheet.Contatos[1][2], 'Enfermagem');
});

test('bloco "Buscar no Google Sheets" traz as colunas pro lead e segue pelo ramo certo', async () => {
  const s = await connectGoogle();
  sheet.Pedidos = [['Pedido', 'Status', 'Previsão'], ['A100', 'Enviado', '20/10'], ['A200', 'Em separação', '25/10']];
  await agent.post('/api/automation-flows').send({
    name: 'Status do pedido', trigger_type: 'keyword', trigger_config: { keyword: 'pedido' },
    steps: [
      { client_id: 'q', step_type: 'ask_question', config: { text: 'Qual o número do pedido?', save_to: 'custom', custom_field: 'Pedido' }, next_step_id: 'b' },
      { client_id: 'b', step_type: 'sheets_lookup', config: { sheet_id: s.id, tab: 'Pedidos', search_column: 'Pedido', search_value: '{{Pedido}}', fields: ['Status', 'Previsão'] },
        next_step_id_true: 'ok', next_step_id_false: 'nao' },
      { client_id: 'ok', step_type: 'send_message', config: { text: 'Seu pedido está: {{Status}} (previsão {{Previsão}})' } },
      { client_id: 'nao', step_type: 'send_message', config: { text: 'Não achei esse pedido.' } },
    ],
  });
  await leadSays('5544955600003', 'meu pedido');
  await leadSays('5544955600003', 'a200');
  assert.equal(whatsappSent.at(-1).text.body, 'Seu pedido está: Em separação (previsão 25/10)');
  const contact = (await query(`SELECT custom_fields FROM contacts WHERE wa_id = '5544955600003'`)).rows[0];
  assert.equal(contact.custom_fields.Status, 'Em separação');

  await leadSays('5544955600004', 'meu pedido');
  await leadSays('5544955600004', 'Z999');
  assert.equal(whatsappSent.at(-1).text.body, 'Não achei esse pedido.');
});

test('"Enviar todo contato novo" grava o lead na planilha sem atrasar o atendimento', async () => {
  const s = await connectGoogle();
  const cfg = await agent.put('/api/integrations/google/new-contacts').send({ enabled: true, sheet_id: s.id, tab: 'Contatos' });
  assert.equal(cfg.status, 200);
  assert.equal((await agent.put('/api/integrations/google/new-contacts').send({ enabled: true })).status, 400);

  await leadSays('5544955600005', 'olá', 'Carlos Lima');
  assert.deepEqual(sheet.Contatos[0], ['Data', 'Nome', 'Telefone', 'E-mail', 'Canal', 'Funil']);
  assert.equal(sheet.Contatos[1][1], 'Carlos Lima');
  assert.equal(sheet.Contatos[1][4], 'WhatsApp');

  // Google fora do ar: o lead continua sendo atendido normalmente.
  await agent.delete('/api/integrations/google');
  await leadSays('5544955600006', 'oi', 'Sem Planilha');
  const conv = (await query(`SELECT count(*)::int AS n FROM conversations`)).rows[0].n;
  assert.equal(conv, 2);
});
