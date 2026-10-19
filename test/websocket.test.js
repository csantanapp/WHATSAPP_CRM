import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { attachRealtime, broadcast, closeRealtime } from '../src/realtime.js';
import { closeDb } from './helpers/db.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail } from '../src/repositories/users.js';

// Canal de tempo real: só quem está logado recebe os eventos (mensagens dos
// clientes passam por aqui).

const EMAIL = 'admin-ws@tractom.com.br';
let server;
let port;
let cookie;

before(async () => {
  const tenantId = await getDefaultTenantId();
  if (!(await findUserByEmail(tenantId, EMAIL))) {
    await createUser(tenantId, { name: 'Admin WS', email: EMAIL, password: 'senha-teste-123', role: 'admin' });
  }
  const app = createApp();
  server = http.createServer(app);
  attachRealtime(server);
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;

  const res = await fetch(`http://localhost:${port}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: 'senha-teste-123' }),
  });
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  closeRealtime();
  await new Promise((resolve) => server.close(resolve));
  await closeDb();
});

function connect(headers = {}) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers });
  const received = [];
  // Listener antes do 'open': o servidor manda "connected" assim que aceita.
  ws.on('message', (data) => received.push(JSON.parse(data.toString())));
  const opened = new Promise((resolve) => {
    ws.on('open', () => resolve({ ok: true }));
    ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on('error', () => resolve({ ok: false, status: 'error' }));
  });
  return { ws, received, opened };
}

test('usuário logado recebe os eventos em tempo real', async () => {
  const { ws, received, opened } = connect({ Cookie: cookie, Origin: `http://localhost:${port}` });
  assert.deepEqual(await opened, { ok: true });
  await new Promise((r) => setTimeout(r, 100));
  broadcast({ type: 'message:new', conversationId: 1, message: { body: 'teste' } });
  await new Promise((r) => setTimeout(r, 100));
  ws.terminate();
  assert.ok(received.some((e) => e.type === 'connected'));
  assert.ok(received.some((e) => e.type === 'message:new'), 'deveria ter recebido o evento de broadcast');
});

test('sem login a conexão é recusada (401) e nada é recebido', async () => {
  const { ws, received, opened } = connect();
  assert.deepEqual(await opened, { ok: false, status: 401 });
  broadcast({ type: 'message:new', conversationId: 1, message: { body: 'segredo do cliente' } });
  await new Promise((r) => setTimeout(r, 100));
  ws.terminate();
  assert.equal(received.length, 0);
});

test('logado mas vindo de outro domínio é recusado (403)', async () => {
  const { ws, opened } = connect({ Cookie: cookie, Origin: 'https://site-malicioso.com' });
  assert.deepEqual(await opened, { ok: false, status: 403 });
  ws.terminate();
});
