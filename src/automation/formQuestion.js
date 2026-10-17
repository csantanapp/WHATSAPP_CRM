import { query } from '../db/pool.js';
import { sendTextMessage, sendButtonsMessage, sendListMessage } from '../whatsapp/client.js';
import { sendInstagramMessage } from '../instagram/client.js';
import { insertMessage } from '../repositories/messages.js';
import { logActivity } from '../repositories/activityLog.js';
import { broadcast } from '../realtime.js';

// Formulário em conversa: o nó "Perguntar" (ask_question) pode
//   - oferecer opções (botões até 3 / lista até 10 no WhatsApp; no Instagram
//     viram uma lista numerada no texto),
//   - validar o formato da resposta (e-mail, telefone, número) e perguntar de
//     novo até `max_retries` vezes,
//   - gravar a resposta na ficha do lead (nome, e-mail ou campo personalizado).
//
// config: { text, reply_type: 'text'|'buttons'|'list', options: [], list_button,
//           validate: 'none'|'email'|'phone'|'number', save_to: ''|'name'|'email'|'custom',
//           custom_field, retry_text, max_retries }

const OPTION_LIMITS = { buttons: { count: 3, chars: 20 }, list: { count: 10, chars: 24 } };

const DEFAULT_RETRY_TEXT = {
  options: 'Por favor, escolha uma das opções abaixo 👇',
  email: 'Hmm, esse e-mail não parece válido. Pode enviar de novo? (ex: nome@empresa.com)',
  phone: 'Não consegui entender o telefone. Pode enviar com DDD? (ex: 44 99999-9999)',
  number: 'Pode responder só com o número, por favor?',
  name: 'Pode me dizer seu nome, por favor?',
  none: 'Não entendi, pode responder de novo?',
};

// Opções já cortadas no limite da Meta — o mesmo texto que o lead vê é o que
// volta no webhook, então é com ele que a resposta é comparada.
function questionOptions(config) {
  const type = config?.reply_type;
  const limits = OPTION_LIMITS[type];
  if (!limits) return [];
  return (config.options || [])
    .map((o) => String(o || '').trim().slice(0, limits.chars))
    .filter(Boolean)
    .slice(0, limits.count);
}

// Envia texto simples pelo canal do contato (WhatsApp ou Instagram).
export async function sendText(contact, text) {
  if (contact.channel === 'instagram') return sendInstagramMessage(contact.ig_user_id, text);
  return sendTextMessage(contact.wa_id, text);
}

// Envia a pergunta (ou a repergunta, com `textOverride`) no formato certo
// pro canal do contato e registra no histórico da conversa.
export async function sendQuestion({ flow, conversation, contact, step, textOverride }) {
  const config = step.config || {};
  const text = textOverride || config.text || '';
  const options = questionOptions(config);
  const numbered = options.map((o, i) => `${i + 1}. ${o}`).join('\n');

  let sent;
  if (options.length && contact.channel !== 'instagram') {
    sent = config.reply_type === 'list'
      ? await sendListMessage(contact.wa_id, text, config.list_button, options)
      : await sendButtonsMessage(contact.wa_id, text, options);
  } else {
    sent = await sendText(contact, options.length ? `${text}\n\n${numbered}` : text);
  }

  const saved = await insertMessage({
    conversationId: conversation.id,
    waMessageId: sent?.messages?.[0]?.id || sent?.message_id,
    direction: 'outbound',
    senderType: 'automation',
    body: options.length ? `${text}\n\n${numbered}` : text,
    automationFlowId: flow.id,
  });
  broadcast({ type: 'message:new', conversationId: conversation.id, message: saved });
}

// Devolve o valor normalizado da resposta, ou null se ela não é válida.
export function parseAnswer(config, rawBody) {
  const answer = (rawBody || '').trim();
  if (!answer) return null;

  const options = questionOptions(config);
  if (options.length) {
    const byTitle = options.find((o) => o.toLowerCase() === answer.toLowerCase());
    if (byTitle) return byTitle;
    // Fallback do Instagram/texto livre: lead responde "2" pra segunda opção.
    const index = /^\d{1,2}$/.test(answer) ? parseInt(answer, 10) - 1 : -1;
    return options[index] || null;
  }

  const validate = config?.validate || (config?.save_to === 'email' ? 'email' : 'none');
  if (validate === 'email') {
    // Aceita o e-mail no meio de uma frase ("meu e-mail é fulano@x.com").
    const match = answer.match(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i);
    return match ? match[0].replace(/[.,;!]+$/, '').toLowerCase() : null;
  }
  if (validate === 'phone') {
    const digits = answer.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 13 ? digits : null;
  }
  if (validate === 'number') {
    const match = answer.match(/\d[\d.,]*/);
    return match ? match[0] : null;
  }
  if (config?.save_to === 'name') {
    // Nome precisa ter pelo menos 2 letras e não ser um textão.
    const letters = answer.replace(/[^a-zA-ZÀ-ÿ]/g, '');
    return letters.length >= 2 && answer.length <= 80 ? answer : null;
  }
  return answer;
}

function retryTextFor(config) {
  if (config?.retry_text) return config.retry_text;
  if (questionOptions(config).length) return DEFAULT_RETRY_TEXT.options;
  const validate = config?.validate || (config?.save_to === 'email' ? 'email' : 'none');
  if (validate !== 'none') return DEFAULT_RETRY_TEXT[validate];
  if (config?.save_to === 'name') return DEFAULT_RETRY_TEXT.name;
  return DEFAULT_RETRY_TEXT.none;
}

function initialsOf(name) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
}

async function saveAnswerToContact({ contact, conversation, config, value }) {
  const saveTo = config?.save_to;
  if (saveTo === 'name') {
    await query(
      'UPDATE contacts SET name = $2, avatar_initials = $3, updated_at = now() WHERE id = $1',
      [contact.id, value, initialsOf(value)]
    );
    contact.name = value;
    await logActivity({ contactId: contact.id, conversationId: conversation.id, type: 'form_answer', description: `Nome informado no formulário: "${value}"` });
  } else if (saveTo === 'email') {
    await query('UPDATE contacts SET email = $2, updated_at = now() WHERE id = $1', [contact.id, value]);
    contact.email = value;
    await logActivity({ contactId: contact.id, conversationId: conversation.id, type: 'form_answer', description: `E-mail informado no formulário: "${value}"` });
  } else if (saveTo === 'custom' && config.custom_field) {
    const field = String(config.custom_field).trim();
    await query(
      `UPDATE contacts SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || jsonb_build_object($2::text, $3::text), updated_at = now() WHERE id = $1`,
      [contact.id, field, value]
    );
    await logActivity({ contactId: contact.id, conversationId: conversation.id, type: 'form_answer', description: `${field}: "${value}"` });
  } else {
    return;
  }
  broadcast({ type: 'contact:updated', contactId: contact.id, conversationId: conversation.id });
}

// Trata a resposta do lead a um nó "Perguntar". Retorna:
//   'retry' — resposta inválida, repergunta enviada, a run continua aguardando;
//   'next'  — segue pro próximo passo (resposta válida, ou tentativas esgotadas).
export async function handleQuestionReply({ flow, run, step, conversation, contact, message }) {
  const config = step.config || {};
  const value = parseAnswer(config, message.body);

  await query(
    'INSERT INTO automation_run_answers (automation_run_id, step_id, answer, is_valid) VALUES ($1,$2,$3,$4)',
    [run.id, step.id, message.body, value !== null]
  );

  if (value === null) {
    const invalid = await query(
      'SELECT count(*)::int AS count FROM automation_run_answers WHERE automation_run_id = $1 AND step_id = $2 AND is_valid = false',
      [run.id, step.id]
    );
    const maxRetries = Number.isInteger(config.max_retries) ? config.max_retries : 2;
    if (invalid.rows[0].count <= maxRetries) {
      await sendQuestion({ flow, conversation, contact, step, textOverride: retryTextFor(config) });
      return 'retry';
    }
    return 'next'; // desiste de validar e segue o fluxo, sem gravar nada na ficha
  }

  await saveAnswerToContact({ contact, conversation, config, value });
  return 'next';
}
