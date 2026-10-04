import { Router } from 'express';
import { pool } from '../db/pool.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', uptime_s: Math.round(process.uptime()) });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'error', message: err.message });
  }
});
