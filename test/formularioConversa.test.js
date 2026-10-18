import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDb, closeDb } from './helpers/db.js';
import { installMockFetch, restoreFetch, jsonResponse } from './helpers/mockFetch.js';
import { getDefaultTenantId } from '../src/tenant.js';
import { createUser, findUserByEmail } from '../src/repositories/users.js';
import { parseAnswer } from '../src/automation/formQuestion.js';

// Formulário em conversa: nó "Perguntar" com validação, botões/lista e
// gravação da resposta na ficha do lead.

const APP_SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin-form@tractom.com.br';
let app;
let agent;
let sent;

before(async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'fake-token';
  app = createApp();

  const tenantId = await getDefaultTenantId();
  if (!(await findUserByEmail(tenantId, ADMIN_EMAIL))) {
    await createUser(tenantId, { name: 'Admin Form', email: ADMIN_EMAIL, password: 'senha-teste-123', role: 'admin' });
  }
  agent = request.agent(app);
  const loginRes = await agent.post('/api/auth/login').send({ email: ADMIN_EMAIL, password: 'senha-teste-123' });
  assert.equal(loginRes.status, 200);
});

beforeEach(async () => {
  await resetDb();
  sent = [];
  installMockFetch(async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return jsonResponse({ messages: [{ id: 'wamid.out.' + Math.random() }] });
  });
});

after(async () => {
  restoreFetch();
  await closeDb();
});

function signPayload(body) {
  const raw = Buffer.from(JSON.stringify(body));
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
}

async function leadSays(waId, message) {
  const msg = typeof message === 'string' ? { type: 'text', text: { body: message } } : message;
  const body = { entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: waId, profile: { name: 'Perfil WhatsApp' } }],
    messages: [{ id: 'wamid.' + Date.now() + Math.random(), from: waId, ...msg }],
  } }] }] };
  await agent.post('/webhook/whatsapp').set('x-hub-signature-256', signPayload(body)).send(body);
  await new Promise((r) => setTimeout(r, 250));
}

async function contactByWaId(waId) {
  const contacts = await agent.get('/api/contacts');
  const contact = contacts.body.find((c) => c.wa_id === waId);
  return (await agent.get(`/api/contacts/${contact.id}`)).body;
}

test('formulário completo: nome, e-mail validado, botões e lista gravam na ficha', async () => {
  const flowRes = await agent.post('/api/automation-flows').send({
    name: 'Qualificação',
    trigger_type: 'first_message',
    steps: [
      { client_id: 'n', step_type: 'ask_question', config: { text: 'Seu nome?', save_to: 'name' }, next_step_id: 'e' },
      { client_id: 'e', step_type: 'ask_question', config: { text: 'Seu e-mail?', validate: 'email', save_to: 'email' }, next_step_id: 'i' },
      { client_id: 'i', step_type: 'ask_question', config: { text: 'Interesse?', reply_type: 'buttons', options: ['Tráfego pago', 'Redes sociais'], save_to: 'custom', custom_field: 'Interesse' }, next_step_id: 'o' },
      { client_id: 'o', step_type: 'ask_question', config: { text: 'Orçamento?', reply_type: 'list', options: ['Até 2 mil', 'Acima de 2 mil'], save_to: 'custom', custom_field: 'Orçamento' }, next_step_id: 'f' },
      { client_id: 'f', step_type: 'send_message', config: { text: 'Obrigado!' } },
    ],
  });
  assert.equal(flowRes.status, 201);

  const waId = '5544900000001';
  await leadSays(waId, 'oi');
  assert.equal(sent.at(-1).text.body, 'Seu nome?');

  await leadSays(waId, 'Maria Souza');
  await leadSays(waId, 'não sei');
  assert.match(sent.at(-1).text.body, /e-mail não parece válido/, 'resposta inválida deve gerar repergunta');

  await leadSays(waId, 'meu e-mail é Maria@Empresa.com');
  const buttons = sent.at(-1);
  assert.equal(buttons.type, 'interactive');
  assert.equal(buttons.interactive.type, 'button');
  assert.deepEqual(buttons.interactive.action.buttons.map((b) => b.reply.title), ['Tráfego pago', 'Redes sociais']);

  await leadSays(waId, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'opt_2', title: 'Redes sociais' } } });
  assert.equal(sent.at(-1).interactive.type, 'list');

  await leadSays(waId, { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'opt_1', title: 'Até 2 mil' } } });
  assert.equal(sent.at(-1).text.body, 'Obrigado!');

  const contact = await contactByWaId(waId);
  assert.equal(contact.name, 'Maria Souza');
  assert.equal(contact.email, 'maria@empresa.com');
  assert.deepEqual(contact.custom_fields, { Interesse: 'Redes sociais', 'Orçamento': 'Até 2 mil' });

  const history = await agent.get(`/api/contacts/${contact.id}/history`);
  assert.ok(history.body.some((h) => h.description.includes('E-mail informado no formulário')));
});

test('tentativas esgotadas: fluxo segue sem gravar o campo', async () => {
  await agent.post('/api/automation-flows').send({
    name: 'E-mail',
    trigger_type: 'first_message',
    steps: [
      { client_id: 'e', step_type: 'ask_question', config: { text: 'E-mail?', validate: 'email', save_to: 'email', max_retries: 1 }, next_step_id: 'f' },
      { client_id: 'f', step_type: 'send_message', config: { text: 'Seguimos!' } },
    ],
  });

  const waId = '5544900000002';
  await leadSays(waId, 'oi');
  await leadSays(waId, 'não');
  assert.match(sent.at(-1).text.body, /não parece válido/);
  await leadSays(waId, 'não tenho');
  assert.equal(sent.at(-1).text.body, 'Seguimos!');

  const contact = await contactByWaId(waId);
  assert.equal(contact.email, null);
});

test('texto numerado e texto numerado + lista mostram as opções na mensagem', async () => {
  const cursos = ['Medicina', 'Enfermagem', 'Odontologia', 'Fisioterapia'];
  await agent.post('/api/automation-flows').send({
    name: 'Cursos',
    trigger_type: 'first_message',
    steps: [
      { client_id: 'a', step_type: 'ask_question', config: { text: 'Qual curso?', reply_type: 'numbered', options: cursos, save_to: 'custom', custom_field: 'Curso' }, next_step_id: 'b' },
      { client_id: 'b', step_type: 'ask_question', config: { text: 'E a segunda opção?', reply_type: 'list_numbered', list_button: 'Escolher', options: cursos, save_to: 'custom', custom_field: 'Curso 2' }, next_step_id: 'f' },
      { client_id: 'f', step_type: 'send_message', config: { text: 'Fim' } },
    ],
  });

  const waId = '5544900000003';
  await leadSays(waId, 'oi');
  const numbered = sent.at(-1);
  assert.equal(numbered.type, 'text');
  assert.equal(numbered.text.body, 'Qual curso?\n\n1. Medicina\n2. Enfermagem\n3. Odontologia\n4. Fisioterapia');

  await leadSays(waId, '7');
  assert.match(sent.at(-1).text.body, /Responda com o número/);
  assert.match(sent.at(-1).text.body, /4\. Fisioterapia/, 'repergunta repete as opções');

  await leadSays(waId, 'odontologia'); // pelo nome, sem acento/maiúscula
  const combo = sent.at(-1);
  assert.equal(combo.interactive.type, 'list');
  assert.equal(combo.interactive.body.text, 'E a segunda opção?\n\n1. Medicina\n2. Enfermagem\n3. Odontologia\n4. Fisioterapia');
  assert.equal(combo.interactive.action.button, 'Escolher');

  await leadSays(waId, '4');
  assert.equal(sent.at(-1).text.body, 'Fim');

  const contact = await contactByWaId(waId);
  assert.deepEqual(contact.custom_fields, { Curso: 'Odontologia', 'Curso 2': 'Fisioterapia' });
});

test('parseAnswer: validações e opções por número', () => {
  assert.equal(parseAnswer({ reply_type: 'numbered', options: ['Estética', 'Medicina'] }, 'opção 2'), 'Medicina');
  assert.equal(parseAnswer({ reply_type: 'numbered', options: ['Estética', 'Medicina'] }, '1.'), 'Estética');
  assert.equal(parseAnswer({ reply_type: 'numbered', options: ['Estética', 'Medicina'] }, 'estetica'), 'Estética');
  assert.equal(parseAnswer({ validate: 'phone' }, '(44) 99999-1234'), '44999991234');
  assert.equal(parseAnswer({ validate: 'phone' }, '123'), null);
  assert.equal(parseAnswer({ save_to: 'name' }, '👍'), null);
  assert.equal(parseAnswer({ reply_type: 'buttons', options: ['A', 'B', 'C'] }, '3'), 'C');
  assert.equal(parseAnswer({ reply_type: 'buttons', options: ['A', 'B'] }, 'talvez'), null);
});

test('submenu por opção: cada opção segue seu ramo, sem ligação vai pelo padrão', async () => {
  const flowRes = await agent.post('/api/automation-flows').send({
    name: 'Cursos com submenu',
    trigger_type: 'first_message',
    steps: [
      {
        client_id: 'curso', step_type: 'ask_question',
        config: { text: 'Qual curso?', reply_type: 'numbered', options: ['Medicina', 'Enfermagem', 'Estética'], branch_by_option: true, save_to: 'custom', custom_field: 'Curso' },
        option_next: { 0: 'med', 1: 'enf' },
        next_step_id: 'geral',
      },
      { client_id: 'med', step_type: 'ask_question', config: { text: 'Modalidade?', reply_type: 'buttons', options: ['Presencial', 'EAD'], save_to: 'custom', custom_field: 'Modalidade' }, next_step_id: 'fim' },
      { client_id: 'enf', step_type: 'send_message', config: { text: 'Ramo enfermagem' } },
      { client_id: 'geral', step_type: 'send_message', config: { text: 'Ramo padrão' } },
      { client_id: 'fim', step_type: 'send_message', config: { text: 'Fim medicina' } },
    ],
  });
  assert.equal(flowRes.status, 201);

  // option_next salvo com ids reais dos passos
  const saved = (await agent.get(`/api/automation-flows/${flowRes.body.id}`)).body;
  const byText = (t) => saved.steps.find((s) => s.config.text === t).id;
  assert.deepEqual(saved.steps[0].config.option_next, { 0: byText('Modalidade?'), 1: byText('Ramo enfermagem') });

  // Medicina -> submenu -> fim
  await leadSays('5544900000010', 'oi');
  await leadSays('5544900000010', '1');
  assert.equal(sent.at(-1).interactive.body.text, 'Modalidade?');
  await leadSays('5544900000010', { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'opt_2', title: 'EAD' } } });
  assert.equal(sent.at(-1).text.body, 'Fim medicina');
  const med = await contactByWaId('5544900000010');
  assert.deepEqual(med.custom_fields, { Curso: 'Medicina', Modalidade: 'EAD' });

  // Enfermagem -> ramo próprio
  await leadSays('5544900000011', 'oi');
  await leadSays('5544900000011', 'enfermagem');
  assert.equal(sent.at(-1).text.body, 'Ramo enfermagem');

  // Estética (sem ligação) -> caminho padrão
  await leadSays('5544900000012', 'oi');
  await leadSays('5544900000012', '3');
  assert.equal(sent.at(-1).text.body, 'Ramo padrão');
});

test('agente de IA fica em silêncio enquanto o formulário trata a mensagem', async () => {
  const created = await agent.post('/api/ai-agents').send({ name: 'Atendente IA', system_prompt: 'Seja simpático.' });
  await agent.patch('/api/ai-agents/' + created.body.id + '/active').send({ is_active: true });

  await agent.post('/api/automation-flows').send({
    name: 'Nome',
    trigger_type: 'first_message',
    steps: [{ client_id: 'n', step_type: 'ask_question', config: { text: 'Seu nome?', save_to: 'name' } }],
  });

  const waId = '5544900000020';
  await leadSays(waId, 'oi');
  assert.deepEqual(sent.map((m) => m.text?.body), ['Seu nome?'], 'só o formulário responde a primeira mensagem');

  await leadSays(waId, 'Joana');
  assert.equal(sent.length, 1, 'resposta ao formulário não aciona a IA');

  // Formulário concluído: a próxima mensagem volta a ser respondida pela IA.
  await leadSays(waId, 'tenho uma dúvida');
  assert.equal(sent.length, 2);
  assert.notEqual(sent.at(-1).text.body, 'Seu nome?');
});
