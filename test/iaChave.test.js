import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail } from '../src/repositories/users.js';
import { query } from '../src/db/pool.js';
import { encryptSecret, decryptSecret } from '../src/services/crypto.js';

const ADMIN_EMAIL = 'admin-iachave@tractom.com.br';
let app;
let agent;
let tenantId;

before(async () => {
  process.env.WHATSAPP_APP_SECRET = 'test-secret';
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64); // 32 bytes hex, só pra teste
  app = createApp();

  tenantId = await getDefaultTenantId();
  const existing = await findUserByEmail(tenantId, ADMIN_EMAIL);
  if (!existing) {
    await createUser(tenantId, { name: 'Admin IA Chave', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
  }
  agent = request.agent(app);
  const loginRes = await agent.post('/api/auth/login').send({ email: ADMIN_EMAIL, password: 'senha-teste-123' });
  assert.equal(loginRes.status, 200);
});

beforeEach(async () => {
  await resetDb();
  await query(`UPDATE ai_settings SET provider = 'mock', api_key_encrypted = NULL WHERE tenant_id = $1`, [tenantId]);
});

after(async () => {
  await closeDb();
});

test('crypto.js: round-trip de criptografia funciona', () => {
  const plain = 'sk-ant-api03-chave-de-mentira-123';
  const encrypted = encryptSecret(plain);
  assert.notEqual(encrypted, plain);
  assert.equal(decryptSecret(encrypted), plain);
});

test('salvar chave de IA: has_api_key vira true e a chave nunca volta em texto puro', async () => {
  const before = await agent.get('/api/ai/settings');
  assert.equal(before.body.has_api_key, false);

  const save = await agent.put('/api/ai/settings').send({ api_key: 'sk-ant-minha-chave-secreta-xyz' });
  assert.equal(save.status, 200);
  assert.equal(save.body.has_api_key, true);
  assert.equal(save.body.api_key, undefined, 'a chave nunca deveria vir no corpo da resposta');
  assert.equal(JSON.stringify(save.body).includes('sk-ant-minha-chave-secreta-xyz'), false);

  const after = await agent.get('/api/ai/settings');
  assert.equal(after.body.has_api_key, true);
  assert.equal(JSON.stringify(after.body).includes('sk-ant'), false, 'GET /ai/settings nunca deveria vazar a chave nem criptografada');
});

test('chave salva fica recuperável (descriptografável) pra uso real pelo backend', async () => {
  await agent.put('/api/ai/settings').send({ api_key: 'sk-ant-outra-chave-456' });

  const row = await query('SELECT api_key_encrypted FROM ai_settings WHERE tenant_id = $1', [tenantId]);
  assert.ok(row.rows[0].api_key_encrypted);
  assert.equal(decryptSecret(row.rows[0].api_key_encrypted), 'sk-ant-outra-chave-456');
});

test('salvar configurações sem api_key não apaga a chave já salva', async () => {
  await agent.put('/api/ai/settings').send({ api_key: 'sk-ant-chave-persistente' });
  await agent.put('/api/ai/settings').send({ monthly_limit: 500 }); // sem api_key no payload

  const row = await query('SELECT api_key_encrypted FROM ai_settings WHERE tenant_id = $1', [tenantId]);
  assert.equal(decryptSecret(row.rows[0].api_key_encrypted), 'sk-ant-chave-persistente');
});
