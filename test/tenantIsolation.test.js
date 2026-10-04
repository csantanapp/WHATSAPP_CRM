import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { query } from '../src/db/pool.js';
import { createUser } from '../src/repositories/users.js';
import { createContact } from '../src/repositories/contacts.js';

// Isolamento de tenant: usuário do tenant B nunca pode ler dados do tenant A,
// mesmo sabendo o ID exato do recurso. Cria um segundo tenant só para este
// teste (o resto da suíte usa o tenant "tractom" único).
let app;
let tenantAId;
let tenantBId;
let contactInTenantA;
let emailA;
let emailB;

before(async () => {
  process.env.WHATSAPP_APP_SECRET = 'test-secret';
  app = createApp();
});

beforeEach(async () => {
  await resetDb();

  // tenants/users não são truncados pelo resetDb (só tabelas de negócio) —
  // usa sufixo único a cada execução pra não colidir com o teste anterior.
  const unique = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  emailA = `usuario-a-${unique}@teste.com`;
  emailB = `usuario-b-${unique}@teste.com`;

  const tenantAResult = await query("SELECT id FROM tenants WHERE slug = 'tractom'");
  tenantAId = tenantAResult.rows[0].id;

  const tenantBResult = await query(
    `INSERT INTO tenants (name, slug) VALUES ('Empresa Teste B', 'empresa-teste-b-' || $1) RETURNING id`,
    [unique]
  );
  tenantBId = tenantBResult.rows[0].id;

  await createUser(tenantAId, { name: 'Usuário A', email: emailA, password: 'senha12345', role: 'admin' });
  await createUser(tenantBId, { name: 'Usuário B', email: emailB, password: 'senha12345', role: 'admin' });

  contactInTenantA = await createContact({ waId: '55119' + Date.now().toString().slice(-8), name: 'Contato do Tenant A' });
});

after(async () => {
  await closeDb();
});

test('usuário do tenant B não vê contatos do tenant A na listagem', async () => {
  const agentB = request.agent(app);
  await agentB.post('/api/auth/login').send({ email: emailB, password: 'senha12345' });

  const res = await agentB.get('/api/contacts');
  assert.equal(res.status, 200);
  assert.ok(
    !res.body.some((c) => c.id === contactInTenantA.id),
    'contato do tenant A não deveria aparecer na listagem do tenant B'
  );
});

test('usuário do tenant B não vê usuários do tenant A', async () => {
  const agentB = request.agent(app);
  await agentB.post('/api/auth/login').send({ email: emailB, password: 'senha12345' });

  const res = await agentB.get('/api/users');
  assert.equal(res.status, 200);
  assert.ok(
    !res.body.some((u) => u.email === emailA),
    'usuário do tenant A não deveria aparecer na listagem de usuários do tenant B'
  );
});

test('login de um tenant não dá acesso a recursos específicos do outro mesmo sabendo o ID', async () => {
  const agentB = request.agent(app);
  await agentB.post('/api/auth/login').send({ email: emailB, password: 'senha12345' });

  const res = await agentB.get(`/api/contacts/${contactInTenantA.id}`);
  assert.notEqual(res.status, 200, 'usuário do tenant B não deveria conseguir ler um contato do tenant A por ID direto');
});
