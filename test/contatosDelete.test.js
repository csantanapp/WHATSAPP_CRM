import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail } from '../src/repositories/users.js';

const ADMIN_EMAIL = 'admin-contatosdelete@tractom.com.br';
let app;
let agent;
let tenantId;

before(async () => {
  process.env.WHATSAPP_APP_SECRET = 'test-secret';
  app = createApp();

  tenantId = await getDefaultTenantId();
  const existing = await findUserByEmail(tenantId, ADMIN_EMAIL);
  if (!existing) {
    await createUser(tenantId, { name: 'Admin Contatos Delete', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
  }
  agent = request.agent(app);
  const loginRes = await agent.post('/api/auth/login').send({ email: ADMIN_EMAIL, password: 'senha-teste-123' });
  assert.equal(loginRes.status, 200);
});

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

test('DELETE /contacts/:id remove o contato', async () => {
  const created = await agent.post('/api/contacts').send({ wa_id: '5511977776666', name: 'Lead pra apagar' });
  assert.equal(created.status, 201);

  const del = await agent.delete('/api/contacts/' + created.body.id);
  assert.equal(del.status, 204);

  const check = await agent.get('/api/contacts/' + created.body.id);
  assert.equal(check.status, 404);
});

test('DELETE /contacts/:id de contato inexistente retorna 404', async () => {
  const res = await agent.delete('/api/contacts/999999');
  assert.equal(res.status, 404);
});

test('atendente não tem permissão de apagar contatos (RBAC)', async () => {
  const email = `atendente-contatosdelete-${Date.now()}@tractom.com.br`;
  await createUser(tenantId, { name: 'Atendente Contatos Delete', email, password: 'senha12345', role: 'atendente' });
  const atendenteAgent = request.agent(app);
  await atendenteAgent.post('/api/auth/login').send({ email, password: 'senha12345' });

  const created = await agent.post('/api/contacts').send({ wa_id: '5511977776601', name: 'Lead protegido' });
  const res = await atendenteAgent.delete('/api/contacts/' + created.body.id);
  assert.equal(res.status, 403);
});
