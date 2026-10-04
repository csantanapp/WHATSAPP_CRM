import { claimDueJobs, markJobDone, markJobFailed } from './scheduledJobs.js';
import { resumeRunAfterWait } from '../automation/engine.js';
import { processRadarJob, ensureRadarScheduled } from './dailyRadarJob.js';
import { logger } from '../logger.js';

const POLL_INTERVAL_MS = 30_000;
let timer = null;

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
}

export function stopJobWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
