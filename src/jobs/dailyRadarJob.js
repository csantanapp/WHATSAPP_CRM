import { query } from '../db/pool.js';
import { getDefaultTenantId } from '../tenant.js';
import { getRadarData } from '../repositories/radar.js';
import { generateDailyRadar } from '../services/ai/AIService.js';
import { scheduleJob } from './scheduledJobs.js';
import { broadcast } from '../realtime.js';
import { logger } from '../logger.js';

// 8h no fuso do tenant seria o ideal — como hoje só existe um tenant real e o
// worker não tem timezone por tenant ainda, usa 8h UTC (~5h em São Paulo).
// Ajustar quando houver tenants em fusos diferentes.
function nextEightAmUtc(from = new Date()) {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 8, 0, 0));
  if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export async function runRadarNow(tenantId) {
  const data = await getRadarData(tenantId);
  const { priorities } = await generateDailyRadar(tenantId, data);

  const result = await query(
    `INSERT INTO daily_radar_results (tenant_id, raw_data, priorities) VALUES ($1,$2,$3) RETURNING *`,
    [tenantId, JSON.stringify(data), JSON.stringify(priorities)]
  );

  broadcast({ type: 'notification:new', tenantId, notification: { kind: 'daily_radar', priorities } });
  logger.info('daily_radar_generated', { tenantId, priorities_count: priorities.length });
  return result.rows[0];
}

export async function scheduleNextRadar() {
  const tenantId = await getDefaultTenantId();
  if (!tenantId) return;
  await scheduleJob('daily_radar', nextEightAmUtc(), { tenantId });
}

// Garante que sempre existe um radar agendado — chamado no boot do worker.
export async function ensureRadarScheduled() {
  const pending = await query(
    `SELECT 1 FROM scheduled_jobs WHERE type = 'daily_radar' AND status = 'pending' LIMIT 1`
  );
  if (pending.rows.length) return;
  await scheduleNextRadar();
}

export async function processRadarJob(job) {
  await runRadarNow(job.payload.tenantId);
  await scheduleNextRadar(); // reagenda pro dia seguinte
}
