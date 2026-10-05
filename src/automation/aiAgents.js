import { query } from '../db/pool.js';
import { getDefaultTenantId } from '../tenant.js';
import { sendTextMessage } from '../whatsapp/client.js';
import { insertMessage } from '../repositories/messages.js';
import { createTask } from '../repositories/tasks.js';
import { setConversationPriority } from '../repositories/conversations.js';
import { listActiveAgentsForDispatch, logAgentRun } from '../repositories/aiAgents.js';
import { replyAsAgent } from '../services/ai/AIService.js';
import { broadcast } from '../realtime.js';
import { logger } from '../logger.js';

// Dispara no máximo 1 Agente de IA por mensagem recebida — o primeiro, em
// ordem de prioridade, cujo gatilho (palavra-chave/horário) casar com a
// mensagem. Não concorre com os fluxos de automação (engine.js): os dois
// mecanismos rodam em paralelo, então evite configurar gatilhos sobrepostos
// num mesmo funil pra não ter duas respostas automáticas pra uma mensagem.
export async function runAiAgentsForInboundMessage({ conversation, contact, message }) {
  const tenantId = await getDefaultTenantId();
  const agents = await listActiveAgentsForDispatch(tenantId, conversation.funnel_id);
  if (!agents.length) return;

  const body = message.body || '';

  for (const agent of agents) {
    if (agent.keyword_regex && !matchesKeyword(agent.keyword_regex, body)) continue;
    if (agent.business_hours_enabled && !withinBusinessHours(agent)) continue;

    if (matchesAnyKeyword(agent.handoff_keywords, body)) {
      await handoffToHuman(agent, conversation, contact);
      await logAgentRun(tenantId, agent.id, conversation.id, 'handoff');
      return;
    }

    let replyText;
    try {
      const transcript = await buildTranscript(conversation.id);
      replyText = await replyAsAgent(tenantId, {
        systemPrompt: agent.system_prompt,
        transcript,
        providerOverride: agent.provider,
      });
    } catch (err) {
      logger.error('ai_agent_reply_failed', { agentId: agent.id, message: err.message });
      await logAgentRun(tenantId, agent.id, conversation.id, 'error');
      return;
    }

    if (!replyText) {
      await logAgentRun(tenantId, agent.id, conversation.id, 'error');
      return;
    }

    if (replyText.trim() === '[[HANDOFF]]' && agent.allow_handoff) {
      await handoffToHuman(agent, conversation, contact);
      await logAgentRun(tenantId, agent.id, conversation.id, 'handoff');
      return;
    }

    const sent = await sendTextMessage(contact.wa_id, replyText);
    const saved = await insertMessage({
      conversationId: conversation.id,
      waMessageId: sent?.messages?.[0]?.id,
      direction: 'outbound',
      senderType: 'automation',
      body: replyText,
    });
    broadcast({ type: 'message:new', conversationId: conversation.id, message: saved });
    await logAgentRun(tenantId, agent.id, conversation.id, 'replied');
    return;
  }
}

async function handoffToHuman(agent, conversation, contact) {
  await createTask({
    contactId: contact.id,
    conversationId: conversation.id,
    title: 'Lead pediu atendente (agente IA: ' + agent.name + ')',
    description: 'O agente de IA identificou que esse contato precisa falar com uma pessoa.',
  });
  await setConversationPriority(conversation.id, true);
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
