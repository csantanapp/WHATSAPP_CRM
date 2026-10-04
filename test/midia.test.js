import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { installMockFetch, restoreFetch } from './helpers/mockFetch.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail } from '../src/repositories/users.js';
import { query } from '../src/db/pool.js';

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-midia@tractom.com.br';
let app;
let agent;

before(async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'fake-token';
  process.env.MEDIA_STORAGE_PATH = '/tmp/media-test';
  delete process.env.OPENAI_API_KEY;
  app = createApp();

  const tenantId = await getDefaultTenantId();
  const existing = await findUserByEmail(tenantId, ADMIN_EMAIL);
  if (!existing) {
    await createUser(tenantId, { name: 'Admin Mídia', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
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

function mockMediaFetch({ imageBytes = Buffer.from('fake-image-bytes'), mimeType = 'image/jpeg' } = {}) {
  installMockFetch(async (url, opts) => {
    const urlStr = String(url);
    // 1) GET metadata da mídia (graph.facebook.com/<media-id>)
    if (urlStr.includes('/wamid-media-123') && !opts?.method) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://fake-cdn.meta.com/file.jpg', mime_type: mimeType, file_size: imageBytes.length }),
      };
    }
    // 2) GET bytes do arquivo (URL temporária)
    if (urlStr.includes('fake-cdn.meta.com')) {
      return { ok: true, status: 200, arrayBuffer: async () => imageBytes.buffer };
    }
    // 3) POST /messages (enviar texto/mídia) e POST /media (upload)
    if (urlStr.includes('/media') && opts?.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ id: 'meta-media-upload-id-1' }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.out.' + Math.random() }] }) };
  });
}

function inboundImagePayload(waId) {
  return { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name: 'Cliente Mídia' } }],
    messages: [{ id: 'wamid.img.1', from: waId, type: 'image', image: { id: 'wamid-media-123', mime_type: 'image/jpeg' } }],
  } }] }] };
}

function inboundAudioPayload(waId) {
  return { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name: 'Cliente Áudio' } }],
    messages: [{ id: 'wamid.audio.1', from: waId, type: 'audio', audio: { id: 'wamid-media-123', mime_type: 'audio/ogg' } }],
  } }] }] };
}

test('mensagem de imagem recebida: baixa, salva e aparece com media_url', async () => {
  mockMediaFetch();
  const body = inboundImagePayload('5511300000001');
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 400));

  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === '5511300000001');
  const detail = await agent.get(`/api/contacts/${contact.id}`);
  const conversationId = detail.body.conversations[0].id;

  const messages = await agent.get(`/api/conversations/${conversationId}/messages`);
  const imgMsg = messages.body.find((m) => m.media_type === 'image/jpeg');
  assert.ok(imgMsg, 'deveria ter uma mensagem com mídia de imagem');
  assert.ok(imgMsg.media_url.startsWith('/api/media/'));
});

test('arquivo salvo é servido pela rota autenticada de mídia', async () => {
  mockMediaFetch();
  const body = inboundImagePayload('5511300000002');
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 400));

  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === '5511300000002');
  const detail = await agent.get(`/api/contacts/${contact.id}`);
  const conversationId = detail.body.conversations[0].id;
  const messages = await agent.get(`/api/conversations/${conversationId}/messages`);
  const imgMsg = messages.body.find((m) => m.media_type === 'image/jpeg');

  const fileRes = await agent.get(imgMsg.media_url);
  assert.equal(fileRes.status, 200);
});

test('mensagem de áudio recebida: tenta transcrever (mock, sem OPENAI_API_KEY) e salva transcrição', async () => {
  mockMediaFetch({ mimeType: 'audio/ogg' });
  const body = inboundAudioPayload('5511300000003');
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 500));

  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === '5511300000003');
  const detail = await agent.get(`/api/contacts/${contact.id}`);
  const conversationId = detail.body.conversations[0].id;
  const messages = await agent.get(`/api/conversations/${conversationId}/messages`);
  const audioMsg = messages.body.find((m) => m.media_type === 'audio/ogg');
  assert.ok(audioMsg, 'deveria ter uma mensagem de áudio');

  const row = await query('SELECT transcription FROM messages WHERE id = $1', [audioMsg.id]);
  assert.ok(row.rows[0].transcription, 'transcrição (ainda que mock) deveria ter sido salva');
  assert.ok(row.rows[0].transcription.includes('OPENAI_API_KEY'));
});

test('envio de mídia pelo atendente: upload + Graph API + salva no histórico', async () => {
  mockMediaFetch();
  const body = inboundImagePayload('5511300000004');
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 400));

  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === '5511300000004');
  const detail = await agent.get(`/api/contacts/${contact.id}`);
  const conversationId = detail.body.conversations[0].id;

  const res = await agent
    .post(`/api/conversations/${conversationId}/media`)
    .attach('file', Buffer.from('fake-pdf-bytes'), { filename: 'proposta.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  assert.equal(res.body.direction, 'outbound');
  assert.equal(res.body.media_filename, 'proposta.pdf');
  assert.ok(res.body.media_url.startsWith('/api/media/'));
});

test('envio de mídia respeita a janela de 24h (422 se fechada)', async () => {
  mockMediaFetch();
  const body = inboundImagePayload('5511300000005');
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 400));

  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === '5511300000005');
  const detail = await agent.get(`/api/contacts/${contact.id}`);
  const conversationId = detail.body.conversations[0].id;

  await query("UPDATE conversations SET last_inbound_at = now() - interval '2 days' WHERE id = $1", [conversationId]);

  const res = await agent
    .post(`/api/conversations/${conversationId}/media`)
    .attach('file', Buffer.from('fake-bytes'), { filename: 'x.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'WINDOW_CLOSED');
});

test('rota de mídia recusa acesso a arquivo de outro tenant', async () => {
  const res = await agent.get('/api/media/99999/algum-arquivo.jpg');
  assert.equal(res.status, 403);
});
