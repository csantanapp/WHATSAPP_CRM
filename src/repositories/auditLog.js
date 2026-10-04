import { query } from '../db/pool.js';

export async function logAudit({ tenantId, userId, action, entityType, entityId, metadata = {}, ip }) {
  await query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, metadata, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId || null, userId || null, action, entityType || null, entityId ? String(entityId) : null, JSON.stringify(metadata), ip || null]
  );
}
