import { query } from '../db/pool.js';
import { getDefaultTenantId } from '../tenant.js';

export async function insertMessage({
  conversationId,
  waMessageId,
  direction,
  senderType = 'contact',
  body,
  mediaUrl,
  mediaType,
  status = 'sent',
  automationFlowId,
  kind = 'message',
}) {
  const tenantId = await getDefaultTenantId();
  const result = await query(
    `INSERT INTO messages
      (tenant_id, conversation_id, wa_message_id, direction, sender_type, body, media_url, media_type, status, automation_flow_id, kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING *`,
    [tenantId, conversationId, waMessageId || null, direction, senderType, body || null, mediaUrl || null, mediaType || null, status, automationFlowId || null, kind]
  );
  return result.rows[0];
}

// Nota interna: nunca sai pela Graph API, não tem wa_message_id, não conta
// como mensagem real pra janela de 24h (não atualiza last_inbound_at).
export async function insertInternalNote({ conversationId, authorUserId, body }) {
  const tenantId = await getDefaultTenantId();
  const result = await query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, body, kind, author_user_id)
     VALUES ($1,$2,'outbound','agent',$3,'internal_note',$4) RETURNING *`,
    [tenantId, conversationId, body, authorUserId || null]
  );
  return result.rows[0];
}

export async function listMessagesByConversation(conversationId) {
  const result = await query(
    'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
    [conversationId]
  );
  return result.rows;
}

export async function updateMessageStatusByWaId(waMessageId, status) {
  const result = await query(
    'UPDATE messages SET status = $2 WHERE wa_message_id = $1 RETURNING *',
    [waMessageId, status]
  );
  return result.rows[0];
}
