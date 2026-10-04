import { query, pool } from '../db/pool.js';
import { getDefaultTenantId } from '../tenant.js';

export async function scheduleJob(type, runAt, payload) {
  const tenantId = await getDefaultTenantId();
  const result = await query(
    `INSERT INTO scheduled_jobs (tenant_id, type, run_at, payload) VALUES ($1,$2,$3,$4) RETURNING *`,
    [tenantId, type, runAt, JSON.stringify(payload || {})]
  );
  return result.rows[0];
}

// Pega jobs vencidos com lock (FOR UPDATE SKIP LOCKED) — seguro mesmo se o
// worker rodar em mais de um processo/réplica no futuro, sem duplicar execução.
export async function claimDueJobs(limit = 10) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT * FROM scheduled_jobs
       WHERE status = 'pending' AND run_at <= now()
       ORDER BY run_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    if (result.rows.length) {
      const ids = result.rows.map((r) => r.id);
      await client.query(`UPDATE scheduled_jobs SET locked_at = now() WHERE id = ANY($1)`, [ids]);
    }
    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function markJobDone(id) {
  await query(`UPDATE scheduled_jobs SET status = 'done' WHERE id = $1`, [id]);
}

export async function markJobFailed(id, errorMessage) {
  await query(
    `UPDATE scheduled_jobs SET status = 'failed', attempts = attempts + 1, last_error = $2 WHERE id = $1`,
    [id, errorMessage]
  );
}
