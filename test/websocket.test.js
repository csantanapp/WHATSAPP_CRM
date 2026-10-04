import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { attachRealtime, broadcast, closeRealtime } from '../src/realtime.js';
import { closeDb } from './helpers/db.js';

let server;
let port;

before(async () => {
  const app = createApp();
  server = http.createServer(app);
  attachRealtime(server);
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});

after(async () => {
  closeRealtime();
  await new Promise((resolve) => server.close(resolve));
  await closeDb();
});

test('cliente conectado via WebSocket recebe evento de broadcast', async () => {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const received = [];
  // Anexa o listener de mensagem ANTES do 'open' resolver — o servidor manda
  // o evento "connected" assim que aceita a conexão, e sem listener pronto
  // nesse instante a mensagem é perdida (EventEmitter não enfileira sem ouvinte).
  ws.on('message', (data) => received.push(JSON.parse(data.toString())));

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  // primeiro evento é sempre {type: "connected"} — aguarda ele chegar antes do broadcast de teste
  await new Promise((r) => setTimeout(r, 100));

  broadcast({ type: 'message:new', conversationId: 1, message: { body: 'teste' } });
  await new Promise((r) => setTimeout(r, 100));

  ws.terminate();

  assert.ok(received.some((e) => e.type === 'connected'));
  assert.ok(received.some((e) => e.type === 'message:new'), 'deveria ter recebido o evento de broadcast');
});
