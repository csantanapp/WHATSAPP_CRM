import { query } from '../db/pool.js';
import { getDefaultTenantId } from '../tenant.js';
import { broadcast } from '../realtime.js';
import { logger } from '../logger.js';

// Sino de notificações. `to` = 'all' (todos os usuários ativos) ou uma lista de
// ids; `exclude` tira quem causou o evento (não se avisa a si mesmo).
// O WebSocket só leva os ids de quem tem notificação nova — o conteúdo é
// buscado pela API, que exige login.
// Nunca derruba o fluxo que a chamou: falha aqui só vira log.
export async function notify({ to = 'all', exclude = null, type, title, body = null, conversationId = null, contactId = null }) {
  try {
    const tenantId = await getDefaultTenantId();
    let userIds;
    if (to === 'all') {
      const result = await query(`SELECT id FROM users WHERE tenant_id = $1 AND status = 'active'`, [tenantId]);
      userIds = result.rows.map((r) => Number(r.id));
    } else {
      userIds = (Array.isArray(to) ? to : [to]).filter(Boolean).map(Number);
    }
    if (exclude != null) userIds = userIds.filter((id) => id !== Number(exclude));
    userIds = [...new Set(userIds)];
    if (!userIds.length) return [];

    const result = await query(
      `INSERT INTO notifications (tenant_id, user_id, type, title, body, conversation_id, contact_id)
       SELECT $1, u, $3, $4, $5, $6, $7 FROM unnest($2::bigint[]) AS u
       RETURNING id, user_id`,
      [tenantId, userIds, type, title, body, conversationId, contactId]
    );
    broadcast({ type: 'notification:new', userIds });
    return result.rows;
  } catch (err) {
    logger.error('notification_failed', { type, message: err.message });
    return [];
  }
}

export async function listNotifications(tenantId, userId, limit = 40) {
  const [items, unread] = await Promise.all([
    query(
      `SELECT n.*, c.avatar_url, c.avatar_initials, c.name AS contact_name, c.channel AS contact_channel
       FROM notifications n LEFT JOIN contacts c ON c.id = n.contact_id
       WHERE n.tenant_id = $1 AND n.user_id = $2
       ORDER BY n.created_at DESC, n.id DESC LIMIT $3`,
      [tenantId, userId, limit]
    ),
    query(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`, [tenantId, userId]),
  ]);
  return { items: items.rows, unread: unread.rows[0].n };
}

export async function markNotificationRead(tenantId, userId, id) {
  const result = await query(
    `UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE tenant_id = $1 AND user_id = $2 AND id = $3 RETURNING id`,
    [tenantId, userId, id]
  );
  return result.rows[0];
}

export async function markAllNotificationsRead(tenantId, userId) {
  await query(`UPDATE notifications SET read_at = now() WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`, [tenantId, userId]);
}

// Abrir a conversa marca como lidas as notificações dela (do usuário).
export async function markConversationNotificationsRead(tenantId, userId, conversationId) {
  await query(
    `UPDATE notifications SET read_at = now() WHERE tenant_id = $1 AND user_id = $2 AND conversation_id = $3 AND read_at IS NULL`,
    [tenantId, userId, conversationId]
  );
}
