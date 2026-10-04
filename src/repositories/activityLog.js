import { query } from '../db/pool.js';

export async function logActivity({ contactId, conversationId, type, description }) {
  await query(
    `INSERT INTO activity_log (contact_id, conversation_id, type, description)
     VALUES ($1,$2,$3,$4)`,
    [contactId, conversationId || null, type, description]
  );
}

export async function getActivityLogForContact(contactId) {
  const result = await query(
    'SELECT * FROM activity_log WHERE contact_id = $1 ORDER BY created_at DESC',
    [contactId]
  );
  return result.rows;
}
