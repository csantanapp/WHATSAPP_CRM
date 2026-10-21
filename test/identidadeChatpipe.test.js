import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';

// Instalações de clientes (BRAND_NAME=chatpipe) com a identidade do chatpipe;
// a da Tractom (sem a variável) continua igual.

afterEach(() => { delete process.env.BRAND_NAME; delete process.env.LOGIN_PORTAL_URL; });

test('chatpipe: verde #72E86F, ícone novo e nome em páginas, CSS e JS', async () => {
  process.env.BRAND_NAME = 'chatpipe';
  const app = createApp();
  const page = (await request(app).get('/')).text;
  assert.ok(page.includes('#72E86F'));
  assert.ok(!/#C8F542/i.test(page), 'nada do verde antigo');
  assert.ok(page.includes('viewBox="0 0 512 512"'), 'ícone da barra lateral trocado');
  assert.ok(!page.includes('chattrack'));

  const css = await request(app).get('/css/base.css');
  assert.match(css.headers['content-type'], /css/);
  assert.ok(css.text.toLowerCase().includes('#72e86f') && !/#c8f542/i.test(css.text));

  const js = (await request(app).get('/js/dialogs.js')).text;
  assert.ok(js.includes('#72E86F') && !/#C8F542/i.test(js));

  const fav = await request(app).get('/favicon.svg');
  assert.equal(fav.status, 200);
  assert.ok(String(fav.body || fav.text).includes('#72E86F'));
});

test('Tractom (sem BRAND_NAME): nada muda', async () => {
  const app = createApp();
  const page = (await request(app).get('/')).text;
  assert.ok(page.includes('#C8F542'));
  assert.ok(page.includes('chattrack'));
  const fav = await request(app).get('/favicon.svg');
  assert.ok(String(fav.body || fav.text).includes('#14EF5D'));
});

test('com LOGIN_PORTAL_URL, /login.html vai para a tela do site com a empresa preenchida', async () => {
  process.env.LOGIN_PORTAL_URL = 'https://chatpipe.com.br/login';
  const res = await request(createApp()).get('/login.html').set('Host', 'iasg.chatpipe.com.br');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://chatpipe.com.br/login?empresa=iasg');
});
