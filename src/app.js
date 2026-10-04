import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webhookRouter } from './whatsapp/webhook.js';
import { apiRouter } from './routes/api.js';
import { healthRouter } from './routes/health.js';
import { securityHeaders, webhookRateLimit, apiRateLimit } from './middleware/security.js';
import { logger, requestLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fábrica do app Express, separada do bootstrap em server.js (que faz o
// .listen() e anexa o WebSocket) — permite testar rotas com supertest sem
// abrir uma porta de verdade.
export function createApp() {
  const app = express();

  app.use(securityHeaders);
  app.use(requestLogger);
  app.use(healthRouter);

  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  app.use('/webhook/whatsapp', webhookRateLimit, webhookRouter);
  app.use('/api', apiRateLimit, apiRouter);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    logger.error('unhandled_error', { message: err.message, stack: err.stack, path: req.path });
    const status = err.status || 500;
    const message = err.status ? err.message : 'Erro interno';
    res.status(status).json({ error: { code: err.code || 'internal_error', message } });
  });

  return app;
}
