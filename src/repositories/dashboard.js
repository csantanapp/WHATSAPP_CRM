import { query } from '../db/pool.js';

export async function getDashboardSummary(tenantId) {
  const [contacts, openConversations, closedThisWeek, messagesLast7Days, automationsActive] = await Promise.all([
    query('SELECT count(*)::int AS count FROM contacts WHERE tenant_id = $1', [tenantId]),
    query("SELECT count(*)::int AS count FROM conversations WHERE tenant_id = $1 AND status != 'closed'", [tenantId]),
    query(
      `SELECT count(*)::int AS count FROM conversations c
       JOIN funnel_stages fs ON fs.id = c.funnel_stage_id
       WHERE c.tenant_id = $1 AND fs.is_closed_stage = true AND c.updated_at >= now() - interval '7 days'`,
      [tenantId]
    ),
    query("SELECT count(*)::int AS count FROM messages WHERE tenant_id = $1 AND created_at >= now() - interval '7 days'", [tenantId]),
    query('SELECT count(*)::int AS count FROM automation_flows WHERE tenant_id = $1 AND is_active = true', [tenantId]),
  ]);

  return {
    totalContacts: contacts.rows[0].count,
    openConversations: openConversations.rows[0].count,
    closedThisWeek: closedThisWeek.rows[0].count,
    messagesLast7Days: messagesLast7Days.rows[0].count,
    activeAutomations: automationsActive.rows[0].count,
  };
}

export async function getRecentConversations(tenantId, limit = 8) {
  const result = await query(
    `SELECT c.*, ct.name AS contact_name, ct.phone_display, ct.avatar_initials, ct.avatar_url, fs.name AS stage_name
     FROM conversations c
     JOIN contacts ct ON ct.id = c.contact_id
     LEFT JOIN funnel_stages fs ON fs.id = c.funnel_stage_id
     WHERE c.tenant_id = $1
     ORDER BY c.last_message_at DESC NULLS LAST
     LIMIT $2`,
    [tenantId, limit]
  );
  return result.rows;
}
