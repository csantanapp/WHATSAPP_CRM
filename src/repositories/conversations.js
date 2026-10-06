import { query } from '../db/pool.js';
import { logActivity } from './activityLog.js';
import { getDefaultTenantId } from '../tenant.js';

// Apesar do nome (mantido por compatibilidade com os imports existentes),
// retorna a conversa mais recente do contato INDEPENDENTE do status — uma
// conversa fechada é reaberta automaticamente quando o contato escreve de
// novo (ver touchConversation), em vez de nascer uma conversa nova do zero.
export async function findOpenConversationForContact(contactId) {
  const result = await query(
    `SELECT * FROM conversations WHERE contact_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [contactId]
  );
  return result.rows[0];
}

export async function createConversation(contactId, { funnelId, funnelStageId } = {}) {
  const tenantId = await getDefaultTenantId();
  const result = await query(
    `INSERT INTO conversations (tenant_id, contact_id, funnel_id, funnel_stage_id, last_message_at)
     VALUES ($1, $2, $3, $4, now()) RETURNING *`,
    [tenantId, contactId, funnelId || null, funnelStageId || null]
  );
  const conversation = result.rows[0];

  if (funnelId) {
    const funnelResult = await query('SELECT name FROM funnels WHERE id = $1', [funnelId]);
    const funnelName = funnelResult.rows[0]?.name || 'funil';
    await logActivity({
      contactId,
      conversationId: conversation.id,
      type: 'entered_funnel',
      description: `Entrou no funil "${funnelName}"`,
    });
  }

  return conversation;
}

export async function findOrCreateOpenConversation(contactId, defaults) {
  const existing = await findOpenConversationForContact(contactId);
  if (existing) return existing;
  return createConversation(contactId, defaults);
}

export async function touchConversation(conversationId, { incrementUnread = false, isInbound = false } = {}) {
  const result = await query(
    `UPDATE conversations SET last_message_at = now(), updated_at = now(),
       unread_count = unread_count + $2,
       last_inbound_at = CASE WHEN $3 THEN now() ELSE last_inbound_at END,
       status = CASE WHEN $3 AND status = 'closed' THEN 'open' ELSE status END,
       closed_at = CASE WHEN $3 AND status = 'closed' THEN NULL ELSE closed_at END
     WHERE id = $1 RETURNING *`,
    [conversationId, incrementUnread ? 1 : 0, isInbound]
  );
  return result.rows[0];
}

// Marca o SLA de primeira resposta na primeira vez que alguém (humano ou
// automação) responde depois de uma mensagem do contato — nunca sobrescreve
// depois de setado uma vez.
export async function markFirstResponseIfNeeded(conversationId) {
  await query(
    `UPDATE conversations SET first_response_at = now()
     WHERE id = $1 AND first_response_at IS NULL`,
    [conversationId]
  );
}

export async function assignConversation(conversationId, userId) {
  const result = await query(
    'UPDATE conversations SET assigned_user_id = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [conversationId, userId]
  );
  return result.rows[0];
}

export async function unassignConversation(conversationId) {
  const result = await query(
    'UPDATE conversations SET assigned_user_id = NULL, updated_at = now() WHERE id = $1 RETURNING *',
    [conversationId]
  );
  return result.rows[0];
}

export async function setConversationStatus(conversationId, status) {
  const result = await query(
    `UPDATE conversations SET status = $2, updated_at = now(),
       closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END
     WHERE id = $1 RETURNING *`,
    [conversationId, status]
  );
  return result.rows[0];
}

export async function setConversationPriority(conversationId, isPriority) {
  const result = await query(
    'UPDATE conversations SET is_priority = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [conversationId, isPriority]
  );
  return result.rows[0];
}

export async function markConversationAsRead(conversationId) {
  const result = await query(
    'UPDATE conversations SET unread_count = 0 WHERE id = $1 RETURNING *',
    [conversationId]
  );
  return result.rows[0];
}

export async function moveConversationToStage(conversationId, funnelStageId) {
  const before = await query('SELECT contact_id FROM conversations WHERE id = $1', [conversationId]);
  const result = await query(
    `UPDATE conversations SET funnel_stage_id = $2, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [conversationId, funnelStageId]
  );
  const conversation = result.rows[0];

  if (conversation && before.rows[0]) {
    const stageResult = await query('SELECT name FROM funnel_stages WHERE id = $1', [funnelStageId]);
    const stageName = stageResult.rows[0]?.name || 'etapa';
    await logActivity({
      contactId: before.rows[0].contact_id,
      conversationId,
      type: 'stage_changed',
      description: `Moveu para a etapa "${stageName}"`,
    });
  }

  return conversation;
}

export async function moveConversationToFunnel(conversationId, funnelId, funnelStageId) {
  const before = await query('SELECT contact_id FROM conversations WHERE id = $1', [conversationId]);
  const result = await query(
    `UPDATE conversations SET funnel_id = $2, funnel_stage_id = $3, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [conversationId, funnelId, funnelStageId || null]
  );
  const conversation = result.rows[0];

  if (conversation && before.rows[0]) {
    const funnelResult = await query('SELECT name FROM funnels WHERE id = $1', [funnelId]);
    const funnelName = funnelResult.rows[0]?.name || 'funil';
    await logActivity({
      contactId: before.rows[0].contact_id,
      conversationId,
      type: 'funnel_changed',
      description: `Redirecionado para o funil "${funnelName}"`,
    });
  }

  return conversation;
}

export async function moveConversationToNextStage(conversationId) {
  const convResult = await query('SELECT * FROM conversations WHERE id = $1', [conversationId]);
  const conversation = convResult.rows[0];
  if (!conversation || !conversation.funnel_stage_id) return conversation;

  const currentStageResult = await query('SELECT * FROM funnel_stages WHERE id = $1', [conversation.funnel_stage_id]);
  const currentStage = currentStageResult.rows[0];
  if (!currentStage) return conversation;

  const nextStageResult = await query(
    `SELECT * FROM funnel_stages WHERE funnel_id = $1 AND position > $2 ORDER BY position ASC LIMIT 1`,
    [currentStage.funnel_id, currentStage.position]
  );
  const nextStage = nextStageResult.rows[0];
  if (!nextStage) return conversation; // já está na última etapa

  return moveConversationToStage(conversationId, nextStage.id);
}

const WINDOW_HOURS = 24;

export async function getConversationDetail(conversationId) {
  const result = await query(
    `SELECT c.*, ct.name AS contact_name, ct.email AS contact_email, ct.phone_display, ct.avatar_initials, ct.avatar_url,
            ct.tags AS contact_tags, ct.source AS contact_source, ct.notes AS contact_notes, ct.wa_id,
            ct.channel AS contact_channel, ct.ig_user_id,
            f.id AS funnel_id_full, f.name AS funnel_name, fs.name AS stage_name,
            u.name AS assigned_user_name,
            (c.last_inbound_at IS NOT NULL AND c.last_inbound_at > now() - interval '${WINDOW_HOURS} hours') AS window_open
     FROM conversations c
     JOIN contacts ct ON ct.id = c.contact_id
     LEFT JOIN funnels f ON f.id = c.funnel_id
     LEFT JOIN funnel_stages fs ON fs.id = c.funnel_stage_id
     LEFT JOIN users u ON u.id = c.assigned_user_id
     WHERE c.id = $1`,
    [conversationId]
  );
  return result.rows[0];
}

// Usado pelo backend antes de mandar mensagem livre — nunca confiar só no
// que o frontend acha que sabe sobre a janela.
export async function isWindowOpen(conversationId) {
  const result = await query(
    `SELECT (last_inbound_at IS NOT NULL AND last_inbound_at > now() - interval '${WINDOW_HOURS} hours') AS open
     FROM conversations WHERE id = $1`,
    [conversationId]
  );
  return result.rows[0]?.open === true;
}

// Atendente só vê as conversas atribuídas a ele + as não atribuídas (regra da
// Fase 2). Admin e supervisor veem tudo. `viewer` é opcional pra não quebrar
// chamadas internas que não têm contexto de usuário (ex: automação).
export async function listConversationsByFunnel(funnelId, viewer) {
  const params = [funnelId];
  let visibilityClause = '';
  if (viewer && viewer.role === 'atendente' && !viewer.isPlatformAdmin) {
    params.push(viewer.id);
    visibilityClause = `AND (c.assigned_user_id = $${params.length} OR c.assigned_user_id IS NULL)`;
  }

  const result = await query(
    `SELECT c.*, ct.name AS contact_name, ct.phone_display, ct.avatar_initials, ct.avatar_url, ct.channel AS contact_channel,
            u.name AS assigned_user_name
     FROM conversations c
     JOIN contacts ct ON ct.id = c.contact_id
     LEFT JOIN users u ON u.id = c.assigned_user_id
     WHERE c.funnel_id = $1 ${visibilityClause}
     ORDER BY c.is_priority DESC, c.last_message_at DESC NULLS LAST`,
    params
  );
  return result.rows;
}

// Inbox: lista TODAS as conversas do tenant (sem depender de funil), com os
// filtros estilo Front/Intercom — Fila (não atribuídas), Minhas, Todas,
// Fechadas. Respeita a mesma regra de visibilidade do Kanban (atendente só
// vê as suas + não atribuídas).
function buildInboxConditions(tenantId, viewer, { tab = 'all', search, unreadOnly, tag } = {}) {
  const conditions = ['c.tenant_id = $1'];
  const params = [tenantId];

  if (tab === 'queue') {
    conditions.push('c.assigned_user_id IS NULL', "c.status != 'closed'");
  } else if (tab === 'mine') {
    params.push(viewer.id);
    conditions.push(`c.assigned_user_id = $${params.length}`, "c.status != 'closed'");
  } else if (tab === 'closed') {
    conditions.push("c.status = 'closed'");
  } else {
    conditions.push("c.status != 'closed'");
    if (viewer.role === 'atendente' && !viewer.isPlatformAdmin) {
      params.push(viewer.id);
      conditions.push(`(c.assigned_user_id = $${params.length} OR c.assigned_user_id IS NULL)`);
    }
  }

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(ct.name ILIKE $${params.length} OR ct.phone_display ILIKE $${params.length} OR ct.wa_id ILIKE $${params.length})`);
  }
  if (unreadOnly) conditions.push('c.unread_count > 0');
  if (tag) {
    params.push(tag);
    conditions.push(`$${params.length} = ANY(ct.tags)`);
  }

  return { where: conditions.join(' AND '), params };
}

export async function listInboxConversations(tenantId, viewer, filters = {}) {
  const { where, params } = buildInboxConditions(tenantId, viewer, filters);
  const result = await query(
    `SELECT c.id, c.status, c.is_priority, c.unread_count, c.assigned_user_id, c.last_message_at,
            ct.name AS contact_name, ct.phone_display, ct.avatar_initials, ct.avatar_url, ct.tags, ct.channel AS contact_channel,
            u.name AS assigned_user_name,
            (SELECT m.body FROM messages m WHERE m.conversation_id = c.id AND m.kind = 'message' ORDER BY m.created_at DESC LIMIT 1) AS last_message_body,
            (SELECT m.media_type FROM messages m WHERE m.conversation_id = c.id AND m.kind = 'message' ORDER BY m.created_at DESC LIMIT 1) AS last_message_media_type
     FROM conversations c
     JOIN contacts ct ON ct.id = c.contact_id
     LEFT JOIN users u ON u.id = c.assigned_user_id
     WHERE ${where}
     ORDER BY c.is_priority DESC, c.last_message_at DESC NULLS LAST
     LIMIT 200`,
    params
  );
  return result.rows;
}

export async function getInboxCounts(tenantId, viewer) {
  const tabs = ['queue', 'mine', 'all', 'closed'];
  const counts = await Promise.all(
    tabs.map(async (tab) => {
      const { where, params } = buildInboxConditions(tenantId, viewer, { tab });
      const result = await query(
        `SELECT count(*)::int AS count FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ${where}`,
        params
      );
      return result.rows[0].count;
    })
  );
  return { queue: counts[0], mine: counts[1], all: counts[2], closed: counts[3] };
}
