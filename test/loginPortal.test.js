import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail, setUserPassword } from '../src/repositories/users.js';

// Login pela tela do site (chatpipe.com.br/login) direto na instalação da empresa.

const PORTAL = 'https://chatpipe.com.br';
const EMAIL = 'portal@iasg.com.br';
let tenantId;

before(async () => {
  process.env.LOGIN_PORTAL_ORIGINS = PORTAL;
  tenantId = await getDefaultTenantId();
});
beforeEach(async () => {
  await resetDb();
  const u = await findUserByEmail(tenantId, EMAIL);
  if (u) await setUserPassword(tenantId, u.id, 'senha-portal-1');
  else await createUser(tenantId, { name: 'Portal', email: EMAIL, password: 'senha-portal-1', role: 'admin' });
});
after(closeDb);

test('pré-requisição do site é liberada só para o login', async () => {
  const app = createApp();
  const ok = await request(app).options('/api/auth/login').set('Origin', PORTAL).set('Access-Control-Request-Method', 'POST');
  assert.equal(ok.status, 204);
  assert.equal(ok.headers['access-control-allow-origin'], PORTAL);
  assert.equal(ok.headers['access-control-allow-credentials'], 'true');

  const other = await request(app).options('/api/contacts').set('Origin', PORTAL).set('Access-Control-Request-Method', 'POST');
  assert.equal(other.headers['access-control-allow-origin'], undefined);
});

test('login vindo do site funciona e a sessão vale na instalação', async () => {
  const ag = request.agent(createApp());
  const res = await ag.post('/api/auth/login').set('Origin', PORTAL).send({ email: EMAIL, password: 'senha-portal-1' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], PORTAL);
  assert.equal((await ag.get('/api/auth/me')).status, 200);
});

test('outras origens e outras rotas continuam bloqueadas', async () => {
  const app = createApp();
  const evil = await request(app).post('/api/auth/login').set('Origin', 'https://golpe.com').send({ email: EMAIL, password: 'senha-portal-1' });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers['access-control-allow-origin'], undefined);

  const ag = request.agent(app);
  await ag.post('/api/auth/login').send({ email: EMAIL, password: 'senha-portal-1' });
  const write = await ag.post('/api/tags').set('Origin', PORTAL).send({ name: 'x' });
  assert.equal(write.status, 403, 'o site não pode mexer no resto da API');
});

test('sem a variável configurada, nada muda', async () => {
  delete process.env.LOGIN_PORTAL_ORIGINS;
  try {
    const res = await request(createApp()).post('/api/auth/login').set('Origin', PORTAL).send({ email: EMAIL, password: 'senha-portal-1' });
    assert.equal(res.status, 403);
  } finally {
    process.env.LOGIN_PORTAL_ORIGINS = PORTAL;
  }
});
