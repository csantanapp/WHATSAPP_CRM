import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail } from '../src/repositories/users.js';
import { findFunnelByMessageKeyword } from '../src/repositories/funnels.js';

// Link de captação do funil: texto = nome do funil, personalizável, e o
// texto antigo continua levando pro funil certo.

const ADMIN_EMAIL = 'admin-linkfunil@tractom.com.br';
let agent;

before(async () => {
  const tenantId = await getDefaultTenantId();
  if (!(await findUserByEmail(tenantId, ADMIN_EMAIL))) {
    await createUser(tenantId, { name: 'Admin', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
  }
  agent = request.agent(createApp());
  assert.equal((await agent.post('/api/auth/login').send({ email: ADMIN_EMAIL, password: 'senha-teste-123' })).status, 200);
});
beforeEach(resetDb);
after(closeDb);

const newFunnel = async (name) => (await agent.post('/api/funnels').send({ name })).body;

test('funil novo usa o próprio nome no link (sem sufixo aleatório); nome repetido ganha número', async () => {
  const a = await newFunnel('Evento SP');
  assert.equal(a.entry_keyword, 'Evento SP');
  const b = await newFunnel('  Evento   SP ');
  assert.equal(b.entry_keyword, 'Evento SP 2');
  assert.equal((await findFunnelByMessageKeyword('Evento SP')).funnel.id, a.id);
  assert.equal((await findFunnelByMessageKeyword('olá! evento sp 2')).funnel.id, b.id, 'o mais longo vence e não diferencia maiúsculas');
});

test('personalizar o texto do link mantém o antigo funcionando', async () => {
  const f = await newFunnel('EVENTO');
  const res = await agent.patch(`/api/funnels/${f.id}`).send({ entry_keyword: 'Estive no stand', welcome_message: 'Que bom te ver!' });
  assert.equal(res.status, 200);
  assert.equal(res.body.entry_keyword, 'Estive no stand');
  assert.deepEqual(res.body.entry_keyword_aliases, ['EVENTO']);
  assert.equal(res.body.welcome_message, 'Que bom te ver!');

  assert.equal((await findFunnelByMessageKeyword('Estive no stand')).funnel.id, f.id);
  assert.equal((await findFunnelByMessageKeyword('EVENTO')).funnel.id, f.id, 'link antigo continua levando pro funil');

  // Voltar pro texto antigo não duplica nada.
  const back = (await agent.patch(`/api/funnels/${f.id}`).send({ entry_keyword: 'evento' })).body;
  assert.equal(back.entry_keyword, 'evento');
  assert.deepEqual(back.entry_keyword_aliases, ['Estive no stand']);
});

test('texto curto ou já usado por outro funil é recusado sem salvar nada', async () => {
  const a = await newFunnel('Feira');
  const b = await newFunnel('Webinar');
  await agent.patch(`/api/funnels/${a.id}`).send({ entry_keyword: 'Feira Medicina' }); // "Feira" vira apelido de A

  const short = await agent.patch(`/api/funnels/${b.id}`).send({ entry_keyword: 'oi', welcome_message: 'não deve salvar' });
  assert.equal(short.status, 400);
  assert.match(short.body.error, /pelo menos 3/);

  const dup = await agent.patch(`/api/funnels/${b.id}`).send({ entry_keyword: 'feira medicina' });
  assert.equal(dup.status, 409);
  const dupAlias = await agent.patch(`/api/funnels/${b.id}`).send({ entry_keyword: 'FEIRA' });
  assert.equal(dupAlias.status, 409, 'apelido de outro funil também conta como usado');

  const after = (await agent.get('/api/funnels')).body.find((f) => f.id === b.id);
  assert.equal(after.entry_keyword, 'Webinar');
  assert.equal(after.welcome_message, null);
});
