import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { installMockFetch, restoreFetch, jsonResponse } from './helpers/mockFetch.js';

// Suíte de não regressão — roda contra DATABASE_URL (deve apontar pro banco
// de teste; ver package.json script "test" e docs/SETUP-TESTES.md).
// Cobre: webhook HMAC, recebimento cria contato/conversa, envio de mensagem,
// Kanban (mover etapa), automação first_message, dashboard, contatos.

const APP_SECRET = 'test-secret';
let app;

before(() => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'fake-token';
  app = createApp();
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
  return { raw, sig };
}

function inboundPayload({ waId = '5511999990000', text = 'Olá', msgId = 'wamid.' + Date.now() } = {}) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              contacts: [{ wa_id: waId, profile: { name: 'Cliente Teste' } }],
              messages: [{ id: msgId, from: waId, type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

// --- health ---

test('GET /health responde ok com banco acessível', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

// --- webhook: verificação (GET) ---

test('webhook GET aceita verify_token correto', async () => {
  const res = await request(app)
    .get('/webhook/whatsapp')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': 'abc123' });
  assert.equal(res.status, 200);
  assert.equal(res.text, 'abc123');
});

test('webhook GET rejeita verify_token errado', async () => {
  const res = await request(app)
    .get('/webhook/whatsapp')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': 'abc123' });
  assert.equal(res.status, 403);
});

// --- webhook: assinatura HMAC (POST) ---

test('webhook POST com assinatura HMAC inválida é rejeitado (401)', async () => {
  const body = inboundPayload();
  const res = await request(app)
    .post('/webhook/whatsapp')
    .set('x-hub-signature-256', 'sha256=assinatura-errada')
    .send(body);
  assert.equal(res.status, 401);
});

test('webhook POST com assinatura HMAC válida é aceito e cria contato+conversa', async () => {
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.out.1' }] }));

  const body = inboundPayload({ waId: '5511988887777', text: 'Quero saber mais' });
  const { sig } = signPayload(body);

  const res = await request(app)
    .post('/webhook/whatsapp')
    .set('x-hub-signature-256', sig)
    .send(body);
  assert.equal(res.status, 200);

  // processamento é assíncrono após o 200 (ver webhook.js) — pequeno aguardo
  await new Promise((r) => setTimeout(r, 300));

  const contacts = await request(app).get('/api/contacts');
  assert.equal(contacts.body.length, 1);
  assert.equal(contacts.body[0].wa_id, '5511988887777');
});

test('webhook não processa a mesma mensagem duas vezes (idempotência por wa_message_id)', async () => {
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.out.1' }] }));
  const body = inboundPayload({ waId: '5511977776666', msgId: 'wamid.duplicada' });
  const { sig } = signPayload(body);

  await request(app).post('/webhook/whatsapp').set('x-hub-signature-256', sig).send(body);
  await new Promise((r) => setTimeout(r, 300));
  await request(app).post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body).sig).send(body);
  await new Promise((r) => setTimeout(r, 300));

  const contacts = await request(app).get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === '5511977776666');
  const detail = await request(app).get(`/api/contacts/${contact.id}`);
  const conversationId = detail.body.conversations[0].id;
  const messages = await request(app).get(`/api/conversations/${conversationId}/messages`);
  assert.equal(messages.body.length, 1, 'mensagem duplicada não deve ser inserida de novo');
});

// --- Kanban: mover etapa ---

test('Kanban: criar funil e mover conversa de etapa', async () => {
  const funnelRes = await request(app).post('/api/funnels').send({ name: 'Funil Teste' });
  assert.equal(funnelRes.status, 201);
  const [stage1, stage2] = funnelRes.body.stages;

  const contactRes = await request(app)
    .post('/api/contacts')
    .send({ wa_id: '5511966665555', name: 'Lead Kanban' });

  // Cria conversa diretamente via webhook simulado seria mais realista, mas
  // aqui testamos a rota de mover etapa isoladamente contra uma conversa
  // criada pelo fluxo de contato (a API não expõe "criar conversa" direto —
  // isso é intencional: conversas nascem do webhook).
  installMockFetch(async () => jsonResponse({ messages: [{ id: 'wamid.k1' }] }));
  const body = inboundPayload({ waId: '5511966665555', text: 'oi' });
  await request(app).post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body).sig).send(body);
  await new Promise((r) => setTimeout(r, 300));

  const detail = await request(app).get(`/api/contacts/${contactRes.body.id}`);
  const conversationId = detail.body.conversations[0].id;

  const moveRes = await request(app)
    .patch(`/api/conversations/${conversationId}/stage`)
    .send({ funnel_stage_id: stage2.id });
  assert.equal(moveRes.status, 200);
  assert.equal(moveRes.body.funnel_stage_id, stage2.id);
});

// --- Automação: first_message ---

test('automação first_message dispara e envia a mensagem configurada', async () => {
  const sentMessages = [];
  installMockFetch(async (_url, opts) => {
    const payload = JSON.parse(opts.body);
    sentMessages.push(payload);
    return jsonResponse({ messages: [{ id: 'wamid.auto.' + sentMessages.length }] });
  });

  const flowRes = await request(app).post('/api/automation-flows').send({
    name: 'Boas-vindas',
    trigger_type: 'first_message',
    steps: [{ step_type: 'send_message', config: { text: 'Olá! Como posso ajudar?' }, position: 0 }],
  });
  assert.equal(flowRes.status, 201);

  const body = inboundPayload({ waId: '5511955554444', text: 'primeira mensagem' });
  await request(app).post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body).sig).send(body);
  await new Promise((r) => setTimeout(r, 400));

  const autoReply = sentMessages.find((m) => m.text?.body === 'Olá! Como posso ajudar?');
  assert.ok(autoReply, 'a automação deveria ter enviado a mensagem de boas-vindas');
});

// --- Dashboard ---

test('dashboard/summary responde com contagens', async () => {
  const res = await request(app).get('/api/dashboard/summary');
  assert.equal(res.status, 200);
  assert.ok(typeof res.body === 'object');
});

// --- Contatos ---

test('contatos: criar, buscar e listar', async () => {
  const create = await request(app).post('/api/contacts').send({ wa_id: '5511944443333', name: 'Fulano' });
  assert.equal(create.status, 201);

  const dup = await request(app).post('/api/contacts').send({ wa_id: '5511944443333', name: 'Fulano de novo' });
  assert.equal(dup.status, 409, 'não deve permitir dois contatos com o mesmo wa_id');

  const list = await request(app).get('/api/contacts').query({ q: 'Fulano' });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
});
