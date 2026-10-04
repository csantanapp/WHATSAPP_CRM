import { query } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';

const SAFE_COLUMNS = 'id, tenant_id, name, email, role, is_platform_admin, status, last_login_at, created_at, updated_at';

export async function findUserByEmail(tenantId, email) {
  const result = await query(
    'SELECT * FROM users WHERE tenant_id = $1 AND lower(email) = lower($2)',
    [tenantId, email]
  );
  return result.rows[0];
}

// Login não sabe o tenant de antemão (o e-mail é único por tenant, não globalmente) —
// busca por e-mail em qualquer tenant ativo. Com um único tenant real hoje isso
// nunca é ambíguo; se/quando houver múltiplos tenants seletor de empresa entra aqui.
export async function findUserByEmailAnyTenant(email) {
  const result = await query(
    `SELECT u.*, t.status AS tenant_status FROM users u
     JOIN tenants t ON t.id = u.tenant_id
     WHERE lower(u.email) = lower($1) LIMIT 1`,
    [email]
  );
  return result.rows[0];
}

export async function getUserById(tenantId, id) {
  const result = await query(
    `SELECT ${SAFE_COLUMNS} FROM users WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  return result.rows[0];
}

export async function listUsers(tenantId) {
  const result = await query(
    `SELECT ${SAFE_COLUMNS} FROM users WHERE tenant_id = $1 ORDER BY created_at ASC`,
    [tenantId]
  );
  return result.rows;
}

export async function createUser(tenantId, { name, email, password, role = 'atendente' }) {
  const passwordHash = await hashPassword(password);
  const result = await query(
    `INSERT INTO users (tenant_id, name, email, password_hash, role)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${SAFE_COLUMNS}`,
    [tenantId, name, email, passwordHash, role]
  );
  return result.rows[0];
}

export async function updateUser(tenantId, id, { name, role, status }) {
  const result = await query(
    `UPDATE users SET
       name = COALESCE($3, name),
       role = COALESCE($4, role),
       status = COALESCE($5, status),
       updated_at = now()
     WHERE tenant_id = $1 AND id = $2 RETURNING ${SAFE_COLUMNS}`,
    [tenantId, id, name ?? null, role ?? null, status ?? null]
  );
  return result.rows[0];
}

export async function setUserPassword(tenantId, id, newPassword) {
  const passwordHash = await hashPassword(newPassword);
  const result = await query(
    `UPDATE users SET password_hash = $3, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 RETURNING ${SAFE_COLUMNS}`,
    [tenantId, id, passwordHash]
  );
  return result.rows[0];
}

export async function touchLastLogin(userId) {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}
