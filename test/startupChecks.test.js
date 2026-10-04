import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertProductionSecrets } from '../src/startupChecks.js';

test('produção sem WHATSAPP_APP_SECRET: boot deve recusar (lançar erro)', () => {
  assert.throws(
    () => assertProductionSecrets({ NODE_ENV: 'production', WHATSAPP_APP_SECRET: '' }),
    /WHATSAPP_APP_SECRET ausente em produção/
  );
});

test('produção com WHATSAPP_APP_SECRET configurado: boot não lança', () => {
  assert.doesNotThrow(() =>
    assertProductionSecrets({ NODE_ENV: 'production', WHATSAPP_APP_SECRET: 'algum-secret' })
  );
});

test('fora de produção: ausência do secret não impede o boot (dev local)', () => {
  assert.doesNotThrow(() => assertProductionSecrets({ NODE_ENV: 'development', WHATSAPP_APP_SECRET: '' }));
  assert.doesNotThrow(() => assertProductionSecrets({ WHATSAPP_APP_SECRET: '' }));
});
