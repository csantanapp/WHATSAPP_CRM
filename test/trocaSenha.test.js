import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail, setUserPassword } from '../src/repositories/users.js';
import { query } from '../src/db/pool.js';

// Admin do cliente entra com senha provisória e precisa criar a dele antes de usar.

let tenantId;
const EMAIL = 'cliente-provisoria@iasg.com.br';

before(async () => { tenantId = await getDefaultTenantId(); });
beforeEach(async () => {
  await resetDb();
  const existing = await findUserByEmail(tenantId, EMAIL);
  if (existing) await setUserPassword(tenantId, existing.id, 'provisoria-123');
  else await createUser(tenantId, { name: 'Cliente', email: EMAIL, password: 'provisoria-123', role: 'admin' });
  await query(`UPDATE users SET must_change_password = true WHERE lower(email) = lower($1)`, [EMAIL]);
});
after(closeDb);

test('com senha provisória a API fica bloqueada até criar a senha nova', async () => {
  const ag = request.agent(createApp());
  const login = await ag.post('/api/auth/login').send({ email: EMAIL, password: 'provisoria-123' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.mustChangePassword, true);

  const blocked = await ag.get('/api/contacts');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'password_change_required');
  assert.equal((await ag.get('/api/auth/me')).status, 200, 'ver quem é continua liberado');

  const same = await ag.post('/api/auth/change-password').send({ currentPassword: 'provisoria-123', newPassword: 'provisoria-123' });
  assert.equal(same.status, 400);

  const ok = await ag.post('/api/auth/change-password').send({ currentPassword: 'provisoria-123', newPassword: 'minha-senha-nova' });
  assert.equal(ok.status, 200);
  assert.equal((await ag.get('/api/contacts')).status, 200, 'liberado na mesma sessão');
  assert.equal((await ag.get('/api/auth/me')).body.user.mustChangePassword, false);

  // Próximo login: senha nova, sem pedir troca de novo.
  const ag2 = request.agent(createApp());
  const again = await ag2.post('/api/auth/login').send({ email: EMAIL, password: 'minha-senha-nova' });
  assert.equal(again.status, 200);
  assert.equal(again.body.user.mustChangePassword, false);
  assert.equal((await ag2.get('/api/contacts')).status, 200);
});
