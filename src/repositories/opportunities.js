import { query } from '../db/pool.js';
import { getDefaultTenantId } from '../tenant.js';

export async function createOpportunity({ contactId, conversationId, funnelId, stageId, title, value, product, ownerUserId, expectedCloseDate }) {
  const tenantId = await getDefaultTenantId();
  const result = await query(
    `INSERT INTO opportunities (tenant_id, contact_id, conversation_id, funnel_id, stage_id, title, value, product, owner_user_id, expected_close_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tenantId, contactId, conversationId || null, funnelId || null, stageId || null, title, value || null, product || null, ownerUserId || null, expectedCloseDate || null]
  );
  return result.rows[0];
}

export async function listOpportunities(tenantId, { status, contactId } = {}) {
  const conditions = ['o.tenant_id = $1'];
  const params = [tenantId];
  if (status) {
    params.push(status);
    conditions.push(`o.status = $${params.length}`);
  }
  if (contactId) {
    params.push(contactId);
    conditions.push(`o.contact_id = $${params.length}`);
  }
  const result = await query(
    `SELECT o.*, c.name AS contact_name, c.phone_display, u.name AS owner_name, lr.name AS loss_reason_name
     FROM opportunities o
     JOIN contacts c ON c.id = o.contact_id
     LEFT JOIN users u ON u.id = o.owner_user_id
     LEFT JOIN loss_reasons lr ON lr.id = o.loss_reason_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY o.created_at DESC`,
    params
  );
  return result.rows;
}

export async function getOpportunityById(tenantId, id) {
  const result = await query('SELECT * FROM opportunities WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  return result.rows[0];
}

export async function updateOpportunity(tenantId, id, { title, value, product, stageId, ownerUserId, expectedCloseDate }) {
  const result = await query(
    `UPDATE opportunities SET
       title = COALESCE($3, title),
       value = COALESCE($4, value),
       product = COALESCE($5, product),
       stage_id = COALESCE($6, stage_id),
       owner_user_id = COALESCE($7, owner_user_id),
       expected_close_date = COALESCE($8, expected_close_date),
       updated_at = now()
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId, id, title ?? null, value ?? null, product ?? null, stageId ?? null, ownerUserId ?? null, expectedCloseDate ?? null]
  );
  return result.rows[0];
}

export async function markOpportunityWon(tenantId, id, value) {
  const result = await query(
    `UPDATE opportunities SET status = 'won', won_at = now(), value = COALESCE($3, value), updated_at = now()
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId, id, value ?? null]
  );
  return result.rows[0];
}

export async function markOpportunityLost(tenantId, id, lossReasonId) {
  const result = await query(
    `UPDATE opportunities SET status = 'lost', lost_at = now(), loss_reason_id = $3, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId, id, lossReasonId || null]
  );
  return result.rows[0];
}

export async function listLossReasons(tenantId) {
  const result = await query('SELECT * FROM loss_reasons WHERE tenant_id = $1 ORDER BY name ASC', [tenantId]);
  return result.rows;
}

// Resumo comercial pro dashboard: aberto/ganho/perdido, valor, ticket médio,
// taxa de conversão e motivos de perda — tudo calculado no SQL.
export async function getOpportunitySummary(tenantId) {
  const result = await query(
    `SELECT
       count(*) FILTER (WHERE status = 'open')::int AS open_count,
       count(*) FILTER (WHERE status = 'won')::int AS won_count,
       count(*) FILTER (WHERE status = 'lost')::int AS lost_count,
       COALESCE(sum(value) FILTER (WHERE status = 'open'), 0)::float AS open_value,
       COALESCE(sum(value) FILTER (WHERE status = 'won'), 0)::float AS won_value,
       COALESCE(avg(value) FILTER (WHERE status = 'won'), 0)::float AS avg_ticket
     FROM opportunities WHERE tenant_id = $1`,
    [tenantId]
  );
  const row = result.rows[0];
  const totalClosed = row.won_count + row.lost_count;
  return {
    ...row,
    conversion_rate: totalClosed > 0 ? row.won_count / totalClosed : 0,
  };
}

// Receita por origem — a visão principal do produto nesta fase.
export async function getRevenueBySource(tenantId) {
  const result = await query(
    `SELECT
       COALESCE(cs.source_type, 'direct') AS source_type,
       COALESCE(cs.campaign_key, '—') AS campaign_key,
       count(DISTINCT co.id)::int AS conversations,
       count(DISTINCT o.id)::int AS opportunities,
       count(DISTINCT o.id) FILTER (WHERE o.status = 'won')::int AS won,
       COALESCE(sum(o.value) FILTER (WHERE o.status = 'won'), 0)::float AS revenue
     FROM conversations co
     LEFT JOIN conversation_sources cs ON cs.conversation_id = co.id
     LEFT JOIN opportunities o ON o.conversation_id = co.id
     WHERE co.tenant_id = $1
     GROUP BY 1, 2
     ORDER BY revenue DESC`,
    [tenantId]
  );
  return result.rows;
}
