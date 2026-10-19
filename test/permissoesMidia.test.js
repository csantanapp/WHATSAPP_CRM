import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, utimes, access } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail } from '../src/repositories/users.js';
import { query } from '../src/db/pool.js';
import { runMediaCleanup } from '../src/jobs/mediaCleanup.js';

// Permissões (excluir funis/etapas/tags/automações e ativar/desativar:
// admin e supervisor; número do WhatsApp: só admin) e limpeza de mídias.

const MEDIA = '/tmp/media-test-permissoes';
const users = { admin: null, supervisor: null, atendente: null };
let tenantId;

async function login(role) {
  const email = `${role}-perm@tractom.com.br`;
  if (!(await findUserByEmail(tenantId, email))) {
    await createUser(tenantId, { name: role, email, password: 'senha-teste-123', role });
  }
  const ag = request.agent(createApp());
  assert.equal((await ag.post('/api/auth/login').send({ email, password: 'senha-teste-123' })).status, 200);
  return ag;
}

before(async () => {
  process.env.MEDIA_STORAGE_PATH = MEDIA;
  tenantId = await getDefaultTenantId();
  for (const role of Object.keys(users)) users[role] = await login(role);
});
beforeEach(resetDb);
after(closeDb);

async function scenario() {
  const funnel = (await users.admin.post('/api/funnels').send({ name: 'Feira' })).body;
  const flow = (await users.admin.post('/api/automation-flows').send({ name: 'Boas-vindas', trigger_type: 'first_message', steps: [] })).body;
  const tag = (await users.admin.post('/api/tags').send({ name: 'vip' })).body;
  return { funnel, stage: funnel.stages[0], flow, tag };
}

test('atendente não exclui nem ativa/desativa; supervisor e admin podem', async () => {
  const s = await scenario();
  const at = users.atendente;
  assert.equal((await at.delete(`/api/funnels/${s.funnel.id}`)).status, 403);
  assert.equal((await at.delete(`/api/stages/${s.stage.id}`)).status, 403);
  assert.equal((await at.delete(`/api/tags/${s.tag.id}`)).status, 403);
  assert.equal((await at.delete(`/api/automation-flows/${s.flow.id}`)).status, 403);
  assert.equal((await at.patch(`/api/automation-flows/${s.flow.id}/active`).send({ is_active: false })).status, 403);
  // Trabalho do dia a dia continua liberado pro atendente.
  assert.equal((await at.post(`/api/funnels/${s.funnel.id}/stages`).send({ name: 'Proposta' })).status, 201);
  assert.equal((await at.patch(`/api/automation-flows/${s.flow.id}`).send({ name: 'Boas-vindas 2' })).status, 200);

  const sup = users.supervisor;
  assert.equal((await sup.patch(`/api/automation-flows/${s.flow.id}/active`).send({ is_active: false })).status, 200);
  assert.equal((await sup.delete(`/api/stages/${s.stage.id}`)).status, 204);
  assert.equal((await sup.delete(`/api/tags/${s.tag.id}`)).status, 204);
  assert.equal((await sup.delete(`/api/automation-flows/${s.flow.id}`)).status, 204);
  assert.equal((await users.admin.delete(`/api/funnels/${s.funnel.id}`)).status, 204);
});

test('só admin troca o número do WhatsApp', async () => {
  assert.equal((await users.atendente.put('/api/settings/whatsapp-number').send({ phone_number: '5511999990000' })).status, 403);
  assert.equal((await users.supervisor.put('/api/settings/whatsapp-number').send({ phone_number: '5511999990000' })).status, 403);
  assert.equal((await users.admin.put('/api/settings/whatsapp-number').send({ phone_number: '5511999990000' })).status, 200);
});

test('id que não é número na URL responde 400, não erro 500', async () => {
  const res = await users.admin.get('/api/contacts/abc');
  assert.equal(res.status, 400);
});

async function fakeMedia(name, { ageHours = 2 } = {}) {
  const dir = path.join(MEDIA, String(tenantId));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, 'x');
  const t = new Date(Date.now() - ageHours * 3600 * 1000);
  await utimes(file, t, t);
  return { file, servePath: `/api/media/${tenantId}/${name}` };
}
const exists = (f) => access(f).then(() => true, () => false);

test('excluir o contato apaga as mídias das mensagens dele', async () => {
  const contact = (await users.admin.post('/api/contacts').send({ wa_id: '5544955700001', name: 'Ana' })).body;
  const conv = (await query('INSERT INTO conversations (tenant_id, contact_id) VALUES ($1,$2) RETURNING id', [tenantId, contact.id])).rows[0];
  const media = await fakeMedia('11111111-1111-1111-1111-111111111111.jpg');
  await query(`INSERT INTO messages (conversation_id, direction, sender_type, body, media_type, media_url) VALUES ($1,'inbound','contact','[imagem]','image',$2)`, [conv.id, media.servePath]);

  assert.equal((await users.admin.delete(`/api/contacts/${contact.id}`)).status, 204);
  assert.equal(await exists(media.file), false);
});

test('limpeza diária apaga só mídias sem mensagem e com mais de 1 hora', async () => {
  const contact = (await users.admin.post('/api/contacts').send({ wa_id: '5544955700002', name: 'Bia' })).body;
  const conv = (await query('INSERT INTO conversations (tenant_id, contact_id) VALUES ($1,$2) RETURNING id', [tenantId, contact.id])).rows[0];
  const used = await fakeMedia('22222222-2222-2222-2222-222222222222.jpg');
  const orphan = await fakeMedia('33333333-3333-3333-3333-333333333333.pdf');
  const fresh = await fakeMedia('44444444-4444-4444-4444-444444444444.ogg', { ageHours: 0 });
  await query(`INSERT INTO messages (conversation_id, direction, sender_type, body, media_type, media_url) VALUES ($1,'inbound','contact','[imagem]','image',$2)`, [conv.id, used.servePath]);

  const dry = await runMediaCleanup({ dryRun: true });
  assert.deepEqual(dry.deleted, [orphan.file]);
  assert.equal(await exists(orphan.file), true, 'simulação não apaga nada');

  await runMediaCleanup();
  assert.equal(await exists(orphan.file), false);
  assert.equal(await exists(used.file), true, 'mídia de mensagem existente fica');
  assert.equal(await exists(fresh.file), true, 'arquivo recém-chegado (upload em andamento) fica');
});
