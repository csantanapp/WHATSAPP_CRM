import { claimDueJobs, markJobDone, markJobFailed } from './scheduledJobs.js';
import { resumeRunAfterWait } from '../automation/engine.js';
import { processRadarJob, ensureRadarScheduled } from './dailyRadarJob.js';
import { logger } from '../logger.js';
import { runMediaCleanup } from './mediaCleanup.js';
import { refreshInstagramTokenIfNeeded } from '../instagram/token.js';

const POLL_INTERVAL_MS = 30_000;
const MEDIA_CLEANUP_MS = 24 * 60 * 60 * 1000;
let timer = null;
let mediaTimer = null;
let igTimer = null;

async function processJob(job) {
  if (job.type === 'automation_resume') {
    await resumeRunAfterWait(job.payload.runId);
    return;
  }
  if (job.type === 'daily_radar') {
    await processRadarJob(job);
    return;
  }
  throw new Error(`Tipo de job desconhecido: ${job.type}`);
}

async function tick() {
  try {
    const jobs = await claimDueJobs(10);
    for (const job of jobs) {
      try {
        await processJob(job);
        await markJobDone(job.id);
      } catch (err) {
        logger.error('scheduled_job_failed', { jobId: job.id, type: job.type, message: err.message });
        await markJobFailed(job.id, err.message);
      }
    }
  } catch (err) {
    logger.error('scheduled_jobs_tick_failed', { message: err.message });
  }
}

export function startJobWorker() {
  if (timer) return;
  timer = setInterval(tick, POLL_INTERVAL_MS);
  tick(); // primeira passada imediata, não espera o primeiro intervalo
  ensureRadarScheduled().catch((err) => logger.error('ensure_radar_scheduled_failed', { message: err.message }));
  // Limpeza de mídias sem uso: 1x por dia (a primeira, 10 min depois de subir).
  const cleanup = () => runMediaCleanup().catch((err) => logger.error('media_cleanup_failed', { message: err.message }));
  mediaTimer = setTimeout(function loop() { cleanup(); mediaTimer = setTimeout(loop, MEDIA_CLEANUP_MS); }, 10 * 60 * 1000);
  // Token do Instagram vence em 60 dias: confere 1x por dia e renova a cada 7.
  const igRefresh = () => refreshInstagramTokenIfNeeded().catch((err) => logger.error('instagram_refresh_loop_failed', { message: err.message }));
  igTimer = setTimeout(function loop() { igRefresh(); igTimer = setTimeout(loop, MEDIA_CLEANUP_MS); }, 5 * 60 * 1000);
}

export function stopJobWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  if (mediaTimer) clearTimeout(mediaTimer);
  mediaTimer = null;
  if (igTimer) clearTimeout(igTimer);
  igTimer = null;
}
