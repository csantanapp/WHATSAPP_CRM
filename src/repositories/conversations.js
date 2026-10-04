import { query } from '../db/pool.js';
import { logActivity } from './activityLog.js';
import { getDefaultTenantId } from '../tenant.js';

export async function findOpenConversationForContact(contactId) {
  const result = await query(
    `SELECT * FROM conversations WHERE contact_id = $1 AND status != 'closed'
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

export async function touchConversation(conversationId, { incrementUnread = false } = {}) {
  const result = await query(
    `UPDATE conversations SET last_message_at = now(), updated_at = now(),
       unread_count = unread_count + $2
     WHERE id = $1 RETURNING *`,
    [conversationId, incrementUnread ? 1 : 0]
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

export async function getConversationDetail(conversationId) {
  const result = await query(
    `SELECT c.*, ct.name AS contact_name, ct.email AS contact_email, ct.phone_display, ct.avatar_initials,
            ct.tags AS contact_tags, ct.source AS contact_source, ct.notes AS contact_notes, ct.wa_id,
            f.id AS funnel_id_full, f.name AS funnel_name, fs.name AS stage_name
     FROM conversations c
     JOIN contacts ct ON ct.id = c.contact_id
     LEFT JOIN funnels f ON f.id = c.funnel_id
     LEFT JOIN funnel_stages fs ON fs.id = c.funnel_stage_id
     WHERE c.id = $1`,
    [conversationId]
  );
  return result.rows[0];
}

export async function listConversationsByFunnel(funnelId) {
  const result = await query(
    `SELECT c.*, ct.name AS contact_name, ct.phone_display, ct.avatar_initials
     FROM conversations c
     JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.funnel_id = $1
     ORDER BY c.last_message_at DESC NULLS LAST`,
    [funnelId]
  );
  return result.rows;
}
