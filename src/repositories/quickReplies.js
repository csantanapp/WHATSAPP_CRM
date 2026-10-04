import { query } from '../db/pool.js';

export async function listQuickReplies(tenantId) {
  const result = await query('SELECT * FROM quick_replies WHERE tenant_id = $1 ORDER BY shortcut ASC', [tenantId]);
  return result.rows;
}

export async function createQuickReply(tenantId, { shortcut, title, body, createdBy }) {
  const result = await query(
    `INSERT INTO quick_replies (tenant_id, shortcut, title, body, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [tenantId, shortcut, title, body, createdBy || null]
  );
  return result.rows[0];
}

export async function updateQuickReply(tenantId, id, { shortcut, title, body }) {
  const result = await query(
    `UPDATE quick_replies SET
       shortcut = COALESCE($3, shortcut),
       title = COALESCE($4, title),
       body = COALESCE($5, body)
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId, id, shortcut ?? null, title ?? null, body ?? null]
  );
  return result.rows[0];
}

export async function deleteQuickReply(tenantId, id) {
  await query('DELETE FROM quick_replies WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
}
