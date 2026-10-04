import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertProductionSecrets } from '../src/startupChecks.js';

test('produção sem WHATSAPP_APP_SECRET: boot deve recusar (lançar erro)', () => {
  assert.throws(
    () => assertProductionSecrets({ NODE_ENV: 'production', WHATSAPP_APP_SECRET: '', SESSION_SECRET: 'x'.repeat(32) }),
    /WHATSAPP_APP_SECRET ausente em produção/
  );
});

test('produção sem SESSION_SECRET: boot deve recusar (lançar erro)', () => {
  assert.throws(
    () => assertProductionSecrets({ NODE_ENV: 'production', WHATSAPP_APP_SECRET: 'algum-secret', SESSION_SECRET: '' }),
    /SESSION_SECRET ausente em produção/
  );
});

test('produção com os dois secrets configurados: boot não lança', () => {
  assert.doesNotThrow(() =>
    assertProductionSecrets({ NODE_ENV: 'production', WHATSAPP_APP_SECRET: 'algum-secret', SESSION_SECRET: 'x'.repeat(32) })
  );
});

test('fora de produção: ausência dos secrets não impede o boot (dev local)', () => {
  assert.doesNotThrow(() => assertProductionSecrets({ NODE_ENV: 'development', WHATSAPP_APP_SECRET: '', SESSION_SECRET: '' }));
  assert.doesNotThrow(() => assertProductionSecrets({ WHATSAPP_APP_SECRET: '', SESSION_SECRET: '' }));
});
