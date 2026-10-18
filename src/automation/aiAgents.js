import { query } from '../db/pool.js';
import { getDefaultTenantId } from '../tenant.js';
import { insertMessage } from '../repositories/messages.js';
import { createTask } from '../repositories/tasks.js';
import { setConversationPriority } from '../repositories/conversations.js';
import { listActiveAgentsForDispatch, logAgentRun } from '../repositories/aiAgents.js';
import { logActivity } from '../repositories/activityLog.js';
import { replyAsAgent } from '../services/ai/AIService.js';
import { sendText } from './formQuestion.js';
import { buildAgentSystemPrompt, parseAgentReply, isHumanRequest, DEFAULT_HANDOFF_MESSAGE } from './agentPrompt.js';
import { broadcast } from '../realtime.js';
import { logger } from '../logger.js';

// Dispara no máximo 1 Agente de IA por mensagem recebida — o primeiro, em
// ordem de prioridade, cujo gatilho (palavra-chave/horário) casar com a
// mensagem. Fica em silêncio quando um fluxo de automação já tratou a
// mensagem (ver whatsapp/webhook.js), quando o contato é "só humano" e quando
// a IA está pausada na conversa (passou pra humano / atendente assumiu).
//
// Agrupamento de rajadas: espera `wait_seconds` depois da ÚLTIMA mensagem do
// cliente antes de responder, pra responder "oi / tudo bem? / queria saber o
// preço" numa mensagem só. O timer fica em memória — se o servidor reiniciar
// nesse intervalo de segundos, aquela resposta não sai (a mensagem continua
// no Inbox pro atendente).
const pendingReplies = new Map(); // conversationId -> timeout

export async function runAiAgentsForInboundMessage({ conversation, contact, message }) {
  if (contact.bot_paused) return; // contato "só humano"
  if (await isAiPaused(conversation.id)) return;

  const tenantId = await getDefaultTenantId();
  const agents = await listActiveAgentsForDispatch(tenantId, conversation.funnel_id);
  if (!agents.length) return;

  const body = message.body || '';
  const agent = agents.find((a) =>
    (!a.keyword_regex || matchesKeyword(a.keyword_regex, body)) &&
    (!a.business_hours_enabled || withinBusinessHours(a))
  );
  if (!agent) return;

  // Pedido de humano detectado antes da IA (palavras do agente + padrão de reserva).
  if (agent.allow_handoff !== false && (matchesAnyKeyword(agent.handoff_keywords, body) || isHumanRequest(body))) {
    cancelPendingReply(conversation.id);
    await handoffToHuman({ tenantId, agent, conversation, contact, reason: 'O cliente pediu para falar com uma pessoa' });
    return;
  }

  const waitMs = Math.max(0, Number(agent.wait_seconds ?? 6)) * 1000;
  cancelPendingReply(conversation.id);
  if (!waitMs) {
    await replyNow({ tenantId, agent, conversation, contact });
    return;
  }
  const timer = setTimeout(() => {
    pendingReplies.delete(String(conversation.id));
    replyNow({ tenantId, agent, conversation, contact }).catch((err) =>
      logger.error('ai_agent_delayed_reply_failed', { conversationId: conversation.id, message: err.message })
    );
  }, waitMs);
  timer.unref?.();
  pendingReplies.set(String(conversation.id), timer);
}

function cancelPendingReply(conversationId) {
  const key = String(conversationId);
  const timer = pendingReplies.get(key);
  if (timer) clearTimeout(timer);
  pendingReplies.delete(key);
}

async function isAiPaused(conversationId) {
  const result = await query('SELECT ai_paused_at FROM conversations WHERE id = $1', [conversationId]);
  return result.rows[0]?.ai_paused_at != null;
}

// Pausa a IA numa conversa (handoff ou atendente assumiu). Exportada pras rotas
// de envio do atendente.
export async function pauseAiForConversation(conversationId, reason) {
  cancelPendingReply(conversationId);
  const result = await query(
    `UPDATE conversations SET ai_paused_at = now(), ai_paused_reason = $2
     WHERE id = $1 AND ai_paused_at IS NULL RETURNING *`,
    [conversationId, reason]
  );
  if (result.rows[0]) broadcast({ type: 'conversation:updated', conversation: result.rows[0] });
  return result.rows[0];
}

export async function resumeAiForConversation(conversationId) {
  const result = await query(
    'UPDATE conversations SET ai_paused_at = NULL, ai_paused_reason = NULL WHERE id = $1 RETURNING *',
    [conversationId]
  );
  if (result.rows[0]) broadcast({ type: 'conversation:updated', conversation: result.rows[0] });
  return result.rows[0];
}

async function sendAsAgent(conversation, contact, text) {
  const sent = await sendText(contact, text, conversation.id);
  const saved = await insertMessage({
    conversationId: conversation.id,
    waMessageId: sent?.messages?.[0]?.id || sent?.message_id,
    direction: 'outbound',
    senderType: 'automation',
    body: text,
  });
  broadcast({ type: 'message:new', conversationId: conversation.id, message: saved });
}

async function replyNow({ tenantId, agent, conversation, contact }) {
  // A situação pode ter mudado durante a espera (atendente respondeu, pausou...).
  if (await isAiPaused(conversation.id)) return;
  const fresh = await query('SELECT bot_paused FROM contacts WHERE id = $1', [contact.id]);
  if (fresh.rows[0]?.bot_paused) return;

  let reply;
  try {
    const transcript = await buildTranscript(conversation.id);
    reply = await replyAsAgent(tenantId, {
      systemPrompt: buildAgentSystemPrompt(agent),
      transcript,
      providerOverride: agent.provider,
    });
  } catch (err) {
    logger.error('ai_agent_reply_failed', { agentId: agent.id, message: err.message });
    await logAgentRun(tenantId, agent.id, conversation.id, 'error');
    return;
  }
  if (!reply) {
    await logAgentRun(tenantId, agent.id, conversation.id, 'error');
    return;
  }

  // Sem chave de IA configurada, a resposta é simulada ("[mock] ...") — em
  // produção ela nunca vai pro cliente.
  if (String(reply.provider || '').startsWith('mock') && process.env.NODE_ENV === 'production') {
    logger.info('ai_agent_skipped_no_ai_key', { agentId: agent.id, conversationId: conversation.id });
    await logAgentRun(tenantId, agent.id, conversation.id, 'no_ai_key');
    return;
  }

  const parsed = parseAgentReply(reply.text);
  if (parsed.kind === 'handoff') {
    if (agent.allow_handoff !== false) {
      await handoffToHuman({ tenantId, agent, conversation, contact, reason: 'A IA não tinha a resposta ou o caso precisa de uma pessoa' });
    }
    return;
  }
  if (parsed.kind === 'silence') {
    await logAgentRun(tenantId, agent.id, conversation.id, 'silence');
    return;
  }

  await sendAsAgent(conversation, contact, parsed.text);
  await logAgentRun(tenantId, agent.id, conversation.id, 'replied');
}

async function handoffToHuman({ tenantId, agent, conversation, contact, reason }) {
  const paused = await pauseAiForConversation(conversation.id, 'Passou para atendimento humano');
  if (!paused) return; // já estava com humano — não avisa de novo

  try {
    await sendAsAgent(conversation, contact, (agent.handoff_message || '').trim() || DEFAULT_HANDOFF_MESSAGE);
  } catch (err) {
    logger.error('ai_agent_handoff_message_failed', { conversationId: conversation.id, message: err.message });
  }
  await createTask({
    contactId: contact.id,
    conversationId: conversation.id,
    title: 'Lead precisa de atendente (agente IA: ' + agent.name + ')',
    description: reason,
  });
  await setConversationPriority(conversation.id, true);
  await logActivity({ contactId: contact.id, conversationId: conversation.id, type: 'ai_handoff', description: `IA passou a conversa para um humano: ${reason}` });
  await logAgentRun(tenantId, agent.id, conversation.id, 'handoff');
}

async function buildTranscript(conversationId) {
  const result = await query(
    `SELECT direction, sender_type, body FROM messages
     WHERE conversation_id = $1 AND kind = 'message' ORDER BY created_at DESC LIMIT 20`,
    [conversationId]
  );
  return result.rows.reverse()
    .map((m) => (m.direction === 'inbound' ? 'Cliente: ' : 'Atendente: ') + (m.body || '[mídia]'))
    .join('\n');
}

function matchesKeyword(regexStr, body) {
  try {
    return new RegExp(regexStr, 'i').test(body);
  } catch {
    return false;
  }
}

function matchesAnyKeyword(keywords, body) {
  if (!keywords || !keywords.length) return false;
  const lower = body.toLowerCase();
  return keywords.some((k) => k && lower.includes(k.toLowerCase()));
}

function withinBusinessHours(agent) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: agent.business_hours_tz || 'America/Sao_Paulo',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const hh = parts.find((p) => p.type === 'hour').value;
    const mm = parts.find((p) => p.type === 'minute').value;
    const nowMinutes = parseInt(hh, 10) * 60 + parseInt(mm, 10);

    const [startH, startM] = (agent.business_hours_start || '09:00').split(':').map(Number);
    const [endH, endM] = (agent.business_hours_end || '18:00').split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  } catch {
    return true;
  }
}
