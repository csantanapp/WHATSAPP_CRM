import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { installMockFetch, restoreFetch, jsonResponse } from './helpers/mockFetch.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail } from '../src/repositories/users.js';
import { query } from '../src/db/pool.js';
import { getInstagramToken, refreshInstagramTokenIfNeeded } from '../src/instagram/token.js';

// Nome do produto por instalação (BRAND_NAME) e renovação automática do token
// do Instagram (vence em 60 dias).

before(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
  const tenantId = await getDefaultTenantId();
  if (!(await findUserByEmail(tenantId, 'admin-igtoken@tractom.com.br'))) {
    await createUser(tenantId, { name: 'Admin', email: 'admin-igtoken@tractom.com.br', password: 'senha-teste-123', role: 'admin' });
  }
});
beforeEach(async () => {
  await resetDb();
  await query('TRUNCATE notifications RESTART IDENTITY CASCADE');
  process.env.INSTAGRAM_PAGE_ACCESS_TOKEN = 'IGAA-token-do-env';
});
after(async () => {
  delete process.env.BRAND_NAME;
  restoreFetch();
  await closeDb();
});

test('sem BRAND_NAME a página mostra chattrack; com BRAND_NAME=chatpipe, chatpipe', async () => {
  delete process.env.BRAND_NAME;
  const plain = await request(createApp()).get('/login.html');
  assert.match(plain.text, /chattrack/);

  process.env.BRAND_NAME = 'chatpipe';
  const app = createApp();
  const login = await request(app).get('/login.html');
  assert.equal(login.status, 200);
  assert.match(login.headers['content-type'], /html/);
  assert.doesNotMatch(login.text, /chattrack/i);
  assert.match(login.text, /chatpipe/);
  const home = await request(app).get('/');
  assert.doesNotMatch(home.text, /chattrack/i);
  // Fora das páginas HTML nada muda; e não dá pra escapar da pasta pública.
  assert.equal((await request(app).get('/js/icons.js')).status, 200);
  assert.notEqual((await request(app).get('/..%2Fpackage.json')).status, 200);
  delete process.env.BRAND_NAME;
});

test('renova o token do Instagram, guarda criptografado e passa a usar o novo', async () => {
  const calls = [];
  installMockFetch(async (url) => {
    calls.push(String(url));
    return jsonResponse({ access_token: 'IGAA-token-novo', token_type: 'bearer', expires_in: 5184000 });
  });
  assert.equal(await getInstagramToken(), 'IGAA-token-do-env');
  const r = await refreshInstagramTokenIfNeeded();
  assert.equal(r.refreshed, true);
  assert.match(calls[0], /refresh_access_token\?grant_type=ig_refresh_token&access_token=IGAA-token-do-env/);
  assert.equal(await getInstagramToken(), 'IGAA-token-novo');
  const raw = (await query(`SELECT value FROM app_settings WHERE key = 'instagram_token'`)).rows[0].value;
  assert.equal(raw.includes('IGAA-token-novo'), false, 'token fica criptografado no banco');

  // Renovado há menos de 7 dias: não chama de novo.
  assert.deepEqual(await refreshInstagramTokenIfNeeded(), { skipped: 'recente' });
  assert.equal(calls.length, 1);
});

test('falha ao renovar avisa os admins no sino (1x por dia) e mantém o token atual', async () => {
  installMockFetch(async () => jsonResponse({ error: { message: 'Token expirado' } }, 400));
  const r = await refreshInstagramTokenIfNeeded({ force: true });
  assert.match(r.error, /Token expirado/);
  assert.equal(await getInstagramToken(), 'IGAA-token-do-env');
  await refreshInstagramTokenIfNeeded({ force: true });
  const n = (await query(`SELECT title FROM notifications`)).rows;
  assert.ok(n.length >= 1);
  assert.ok(n.every((x) => x.title === 'Instagram: renove a conexão'));
  const perUser = (await query(`SELECT user_id, count(*)::int AS c FROM notifications GROUP BY 1`)).rows;
  assert.ok(perUser.every((x) => x.c === 1), 'não repete o aviso no mesmo dia');
});
