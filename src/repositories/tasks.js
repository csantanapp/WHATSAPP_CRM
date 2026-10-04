import { query } from '../db/pool.js';
import { getDefaultTenantId } from '../tenant.js';

export async function createTask({ contactId, conversationId, opportunityId, assignedUserId, title, description, dueAt, createdBy }) {
  const tenantId = await getDefaultTenantId();
  const result = await query(
    `INSERT INTO tasks (tenant_id, contact_id, conversation_id, opportunity_id, assigned_user_id, title, description, due_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [tenantId, contactId || null, conversationId || null, opportunityId || null, assignedUserId || null, title, description || null, dueAt || null, createdBy || null]
  );
  return result.rows[0];
}

// \"Minhas tarefas\": hoje, atrasadas e próximas, pro usuário logado.
export async function listTasksForUser(tenantId, userId) {
  const result = await query(
    `SELECT t.*, c.name AS contact_name, c.phone_display
     FROM tasks t
     LEFT JOIN contacts c ON c.id = t.contact_id
     WHERE t.tenant_id = $1 AND t.assigned_user_id = $2 AND t.status = 'pending'
     ORDER BY t.due_at ASC NULLS LAST`,
    [tenantId, userId]
  );
  return result.rows;
}

export async function listTasksForContact(contactId) {
  const result = await query('SELECT * FROM tasks WHERE contact_id = $1 ORDER BY due_at ASC NULLS LAST', [contactId]);
  return result.rows;
}

export async function completeTask(tenantId, id) {
  const result = await query(
    `UPDATE tasks SET status = 'completed', completed_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId, id]
  );
  return result.rows[0];
}

export async function cancelTask(tenantId, id) {
  const result = await query(
    `UPDATE tasks SET status = 'cancelled' WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId, id]
  );
  return result.rows[0];
}

export async function countOverdueTasks(tenantId, userId) {
  const result = await query(
    `SELECT count(*)::int AS count FROM tasks
     WHERE tenant_id = $1 AND assigned_user_id = $2 AND status = 'pending' AND due_at < now()`,
    [tenantId, userId]
  );
  return result.rows[0].count;
}
