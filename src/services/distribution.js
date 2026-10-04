import { query } from '../db/pool.js';
import { getDefaultTenantId } from '../tenant.js';

export async function getDistributionRule(tenantId) {
  const result = await query('SELECT * FROM distribution_rules WHERE tenant_id = $1', [tenantId]);
  return result.rows[0] || null;
}

export async function upsertDistributionRule(tenantId, { mode, participantUserIds, isActive }) {
  const result = await query(
    `INSERT INTO distribution_rules (tenant_id, mode, participant_user_ids, is_active)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id) DO UPDATE SET
       mode = EXCLUDED.mode, participant_user_ids = EXCLUDED.participant_user_ids,
       is_active = EXCLUDED.is_active, updated_at = now()
     RETURNING *`,
    [tenantId, mode, participantUserIds || [], isActive ?? false]
  );
  return result.rows[0];
}

// Escolhe o próximo atendente em round-robin e avança o ponteiro persistido —
// cada chamada avança exatamente uma posição, mesmo sob concorrência (o
// UPDATE...RETURNING é atômico).
export async function pickNextRoundRobinUser(tenantId) {
  const ruleResult = await query(
    `UPDATE distribution_rules SET
       last_assigned_index = (last_assigned_index + 1) % GREATEST(array_length(participant_user_ids, 1), 1),
       updated_at = now()
     WHERE tenant_id = $1 AND mode = 'round_robin' AND is_active = true
       AND array_length(participant_user_ids, 1) > 0
     RETURNING *`,
    [tenantId]
  );
  const rule = ruleResult.rows[0];
  if (!rule) return null;
  return rule.participant_user_ids[rule.last_assigned_index];
}

export async function pickNextRoundRobinUserDefault() {
  return pickNextRoundRobinUser(await getDefaultTenantId());
}
