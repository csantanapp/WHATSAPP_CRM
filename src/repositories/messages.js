import { query } from '../db/pool.js';

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
}) {
  const result = await query(
    `INSERT INTO messages
      (conversation_id, wa_message_id, direction, sender_type, body, media_url, media_type, status, automation_flow_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING *`,
    [conversationId, waMessageId || null, direction, senderType, body || null, mediaUrl || null, mediaType || null, status, automationFlowId || null]
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
