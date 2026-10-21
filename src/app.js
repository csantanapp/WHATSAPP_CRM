import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webhookRouter } from './whatsapp/webhook.js';
import { instagramWebhookRouter } from './instagram/webhook.js';
import { apiRouter } from './routes/api.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { securityHeaders, webhookRateLimit, apiRateLimit } from './middleware/security.js';
import { logger, requestLogger } from './logger.js';
import { createSessionMiddleware } from './auth/session.js';
import { requireAuth, requirePasswordChanged, verifyOrigin } from './middleware/auth.js';
import { loginPortalCors } from './middleware/loginPortal.js';
import { brandedAssets, loginPortalRedirect } from './brand.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fábrica do app Express, separada do bootstrap em server.js (que faz o
// .listen() e anexa o WebSocket) — permite testar rotas com supertest sem
// abrir uma porta de verdade.
export function createApp() {
  const app = express();

  // O app roda atrás do Caddy compartilhado (reverse proxy na mesma rede
  // Docker) — sem isso, o Express não confia no cabeçalho X-Forwarded-For,
  // e o express-rate-limit recusa (por segurança) usar o IP dali, lançando
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR em toda requisição. 1 = confia em
  // 1 hop de proxy à frente (o Caddy), não a cadeia inteira.
  app.set('trust proxy', 1);

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
  app.use('/webhook/instagram', webhookRateLimit, instagramWebhookRouter);

  // Sessão só é necessária a partir daqui (login e tudo que exige usuário).
  app.use(loginPortalCors); // login vindo de chatpipe.com.br/login
  app.use(createSessionMiddleware());
  app.use(verifyOrigin);

  app.use('/api/auth', apiRateLimit, authRouter);
  app.use('/api/users', apiRateLimit, usersRouter);
  app.use('/api', apiRateLimit, requireAuth, requirePasswordChanged, apiRouter);
  // Identidade por instalação (BRAND_NAME): clientes veem o chatpipe (nome,
  // ícone e verde da marca); sem a variável fica o chattrack da Tractom.
  app.use(loginPortalRedirect);
  app.use(brandedAssets(path.join(__dirname, '..', 'public')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    // Id que não é número na URL (ex: /api/contacts/abc): pedido inválido, não erro do servidor.
    if (err.code === '22P02') {
      return res.status(400).json({ error: { code: 'invalid_id', message: 'Identificador inválido.' } });
    }
    logger.error('unhandled_error', { message: err.message, stack: err.stack, path: req.path });
    const status = err.status || 500;
    const message = err.status ? err.message : 'Erro interno';
    res.status(status).json({ error: { code: err.code || 'internal_error', message } });
  });

  return app;
}
