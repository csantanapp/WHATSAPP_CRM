import { query } from '../db/pool.js';
import { sendTextMessage, sendButtonsMessage, sendListMessage } from '../whatsapp/client.js';
import { sendInstagramMessage } from '../instagram/client.js';
import { insertMessage } from '../repositories/messages.js';
import { logActivity } from '../repositories/activityLog.js';
import { broadcast } from '../realtime.js';
import { renderTemplate } from './variables.js';
import { simulateTyping } from '../services/typing.js';
import { addInterest } from '../repositories/contactInterests.js';

// Formulário em conversa: o nó "Perguntar" (ask_question) pode
//   - oferecer opções: botões (até 3), lista (até 10, atrás do botão "Ver
//     opções"), texto numerado (opções escritas na mensagem, lead responde
//     com o número ou o nome) ou texto numerado + lista (as duas coisas); no
//     Instagram qualquer formato com opções vira texto numerado,
//   - validar o formato da resposta (e-mail, telefone, número) e perguntar de
//     novo até `max_retries` vezes,
//   - gravar a resposta na ficha do lead (nome, e-mail ou campo personalizado).
//
// config: { text, reply_type: 'text'|'buttons'|'list'|'numbered'|'list_numbered', options: [], list_button,
//           validate: 'none'|'email'|'phone'|'number', save_to: ''|'name'|'email'|'custom',
//           custom_field, retry_text, max_retries }

const OPTION_LIMITS = {
  buttons: { count: 3, chars: 20 },
  list: { count: 10, chars: 24 },
  list_numbered: { count: 10, chars: 24 }, // limite da lista da Meta
  numbered: { count: 20, chars: 60 }, // só texto: limite nosso, pra mensagem não virar um textão
};

const DEFAULT_RETRY_TEXT = {
  options: 'Por favor, escolha uma das opções abaixo 👇',
  numbered: 'Não encontrei essa opção. Responda com o número de uma das opções abaixo 👇',
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

// Envia texto simples pelo canal do contato (WhatsApp ou Instagram). Com
// `conversationId`, mostra "digitando..." antes (mensagem automática).
export async function sendText(contact, text, conversationId = null) {
  if (conversationId) await simulateTyping({ conversationId, contact, text });
  if (contact.channel === 'instagram') return sendInstagramMessage(contact.ig_user_id, text);
  return sendTextMessage(contact.wa_id, text);
}

// Envia a pergunta (ou a repergunta, com `textOverride`) no formato certo
// pro canal do contato e registra no histórico da conversa.
export async function sendQuestion({ flow, conversation, contact, step, textOverride }) {
  const config = step.config || {};
  const text = renderTemplate(textOverride || config.text || '', contact);
  const options = questionOptions(config);
  const numbered = options.map((o, i) => `${i + 1}. ${o}`).join('\n');

  const textWithOptions = options.length ? `${text}\n\n${numbered}` : text;
  const type = config.reply_type;
  await simulateTyping({ conversationId: conversation.id, contact, text: textWithOptions });

  let sent;
  if (options.length && contact.channel !== 'instagram' && type === 'buttons') {
    sent = await sendButtonsMessage(contact.wa_id, text, options);
  } else if (options.length && contact.channel !== 'instagram' && type === 'list') {
    sent = await sendListMessage(contact.wa_id, text, config.list_button, options);
  } else if (options.length && contact.channel !== 'instagram' && type === 'list_numbered') {
    // Opções visíveis na própria mensagem e também no botão da lista.
    sent = await sendListMessage(contact.wa_id, textWithOptions, config.list_button, options);
  } else {
    sent = await sendText(contact, textWithOptions);
  }

  const saved = await insertMessage({
    conversationId: conversation.id,
    waMessageId: sent?.messages?.[0]?.id || sent?.message_id,
    direction: 'outbound',
    senderType: 'automation',
    body: textWithOptions,
    automationFlowId: flow.id,
    automationStepId: step.id,
  });
  broadcast({ type: 'message:new', conversationId: conversation.id, message: saved });
}

// Devolve o valor normalizado da resposta, ou null se ela não é válida.
export function parseAnswer(config, rawBody) {
  const answer = (rawBody || '').trim();
  if (!answer) return null;

  const options = questionOptions(config);
  if (options.length) {
    // Compara sem acento/maiúscula: "fisioterapia" casa com "Fisioterapia".
    const byTitle = options.find((o) => normalize(o) === normalize(answer));
    if (byTitle) return byTitle;
    // Texto numerado: lead responde "2", "2.", "2)" ou "opção 2".
    const match = answer.match(/^(?:op[cç][aã]o\s*)?(\d{1,2})\s*[.)-]?$/i);
    const index = match ? parseInt(match[1], 10) - 1 : -1;
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

function normalize(text) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function retryTextFor(config) {
  if (config?.retry_text) return config.retry_text;
  if (questionOptions(config).length) {
    return config.reply_type === 'numbered' ? DEFAULT_RETRY_TEXT.numbered : DEFAULT_RETRY_TEXT.options;
  }
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
      `UPDATE contacts SET name = $2, avatar_initials = $3, confirmed_fields = array_append(array_remove(confirmed_fields, 'name'), 'name'), updated_at = now() WHERE id = $1`,
      [contact.id, value, initialsOf(value)]
    );
    contact.name = value;
    contact.confirmed_fields = [...(contact.confirmed_fields || []).filter((f) => f !== 'name'), 'name'];
    await logActivity({ contactId: contact.id, conversationId: conversation.id, type: 'form_answer', description: `Nome informado no formulário: "${value}"` });
  } else if (saveTo === 'email') {
    await query(
      `UPDATE contacts SET email = $2, confirmed_fields = array_append(array_remove(confirmed_fields, 'email'), 'email'), updated_at = now() WHERE id = $1`,
      [contact.id, value]
    );
    contact.email = value;
    contact.confirmed_fields = [...(contact.confirmed_fields || []).filter((f) => f !== 'email'), 'email'];
    await logActivity({ contactId: contact.id, conversationId: conversation.id, type: 'form_answer', description: `E-mail informado no formulário: "${value}"` });
  } else if (saveTo === 'custom' && config.custom_field) {
    const field = String(config.custom_field).trim();
    await query(
      `UPDATE contacts SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || jsonb_build_object($2::text, $3::text), updated_at = now() WHERE id = $1`,
      [contact.id, field, value]
    );
    // Mantém o contato em memória atualizado pra {{Campo}} nos passos seguintes do mesmo fluxo.
    contact.custom_fields = { ...(contact.custom_fields || {}), [field]: value };
    await logActivity({ contactId: contact.id, conversationId: conversation.id, type: 'form_answer', description: `${field}: "${value}"` });
  } else {
    return;
  }
  broadcast({ type: 'contact:updated', contactId: contact.id, conversationId: conversation.id });
}

// Trata a resposta do lead a um nó "Perguntar". Retorna { outcome, nextStepId }:
//   outcome 'retry' — resposta inválida, repergunta enviada, a run continua aguardando;
//   outcome 'next'  — segue pro próximo passo (resposta válida, ou tentativas esgotadas).
// nextStepId é o passo do ramo da opção escolhida quando o nó tem "caminho por
// opção" (config.branch_by_option + config.option_next), senão o next_step_id normal.
export async function handleQuestionReply({ flow, run, step, conversation, contact, message }) {
  const config = step.config || {};
  const value = parseAnswer(config, message.body);

  const optionIndex = value !== null ? questionOptions(config).indexOf(value) : -1;
  await query(
    'INSERT INTO automation_run_answers (automation_run_id, step_id, answer, is_valid, option_index) VALUES ($1,$2,$3,$4,$5)',
    [run.id, step.id, message.body, value !== null, optionIndex >= 0 ? optionIndex : null]
  );

  if (value === null) {
    const invalid = await query(
      'SELECT count(*)::int AS count FROM automation_run_answers WHERE automation_run_id = $1 AND step_id = $2 AND is_valid = false',
      [run.id, step.id]
    );
    const maxRetries = Number.isInteger(config.max_retries) ? config.max_retries : 2;
    if (invalid.rows[0].count <= maxRetries) {
      await sendQuestion({ flow, conversation, contact, step, textOverride: retryTextFor(config) });
      return { outcome: 'retry' };
    }
    // Desiste de validar e segue pelo caminho padrão, sem gravar nada na ficha.
    return { outcome: 'next', nextStepId: step.next_step_id };
  }

  await saveAnswerToContact({ contact, conversation, config, value });
  // "Registrar como produto de interesse": a resposta entra no histórico do lead.
  if (config.track_interest) {
    await addInterest({ contactId: contact.id, product: value, source: 'form', sourceLabel: flow.name, conversationId: conversation.id });
  }
  return { outcome: 'next', nextStepId: nextStepForAnswer(step, value) };
}

// Passo seguinte depois de uma resposta: o ramo da opção (nó com "caminho
// por opção") ou o caminho padrão.
export function nextStepForAnswer(step, value) {
  const config = step.config || {};
  const optionIndex = questionOptions(config).indexOf(value);
  const branchStepId = config.branch_by_option && optionIndex !== -1 ? config.option_next?.[optionIndex] : null;
  return branchStepId || step.next_step_id;
}

// "Pular esta pergunta se o lead já tiver esse dado": devolve o valor que a
// ficha já tem (então a pergunta é pulada), ou null se precisa perguntar.
// Nome/e-mail só contam se confirmados por uma pessoa (confirmed_fields).
export function knownAnswer(contact, config) {
  if (!config?.skip_if_known) return null;
  const confirmed = contact.confirmed_fields || [];
  if (config.save_to === 'name') return confirmed.includes('name') && contact.name ? contact.name : null;
  if (config.save_to === 'email') return confirmed.includes('email') && contact.email ? contact.email : null;
  if (config.save_to === 'custom' && config.custom_field) {
    const value = (contact.custom_fields || {})[String(config.custom_field).trim()];
    return value ? String(value) : null;
  }
  return null;
}
