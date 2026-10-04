import { query } from '../db/pool.js';
import { getDefaultTenantId } from '../tenant.js';

export async function listTags(tenantId) {
  const result = await query('SELECT * FROM tags WHERE tenant_id = $1 ORDER BY name ASC', [tenantId]);
  return result.rows;
}

export async function createTag(name, color) {
  const tenantId = await getDefaultTenantId();
  const result = await query(
    `INSERT INTO tags (tenant_id, name, color) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET color = tags.color
     RETURNING *`,
    [tenantId, name, color || '#5B5F58']
  );
  return result.rows[0];
}

export async function deleteTag(id) {
  await query('DELETE FROM tags WHERE id = $1', [id]);
}
