import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closeDb } from './helpers/db.js';

// Defesa em profundidade: mesmo que o boot (assertProductionSecrets) seja
// contornado por algum motivo, o próprio webhook precisa recusar tudo em
// produção sem secret configurado — nunca cair no fallback "permite sem
// validar" que só existe para conveniência de desenvolvimento local.
let app;

before(() => {
  process.env.NODE_ENV = 'production';
  process.env.WHATSAPP_APP_SECRET = '';
  process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
  app = createApp();
});

after(async () => {
  process.env.NODE_ENV = 'test';
  await closeDb();
});

test('produção sem secret: POST sem assinatura é 401', async () => {
  const res = await request(app).post('/webhook/whatsapp').send({ entry: [] });
  assert.equal(res.status, 401);
});

test('produção sem secret: POST com assinatura qualquer (forjada) ainda é 401', async () => {
  const res = await request(app)
    .post('/webhook/whatsapp')
    .set('x-hub-signature-256', 'sha256=qualquercoisa')
    .send({ entry: [] });
  assert.equal(res.status, 401);
});
