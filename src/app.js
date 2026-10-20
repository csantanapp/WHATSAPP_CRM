import { readFile } from 'node:fs/promises';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fábrica do app Express, separada do bootstrap em server.js (que faz o
// .listen() e anexa o WebSocket) — permite testar rotas com supertest sem
// abrir uma porta de verdade.
// Serve as páginas HTML trocando o nome do produto pelo de BRAND_NAME.
function brandedHtml(publicDir) {
  const cache = new Map();
  return async (req, res, next) => {
    const brand = (process.env.BRAND_NAME || '').trim();
    if (!brand || brand.toLowerCase() === 'chattrack' || req.method !== 'GET') return next();
    let rel = decodeURIComponent(req.path);
    if (rel.endsWith('/')) rel += 'index.html';
    if (!rel.endsWith('.html')) return next();
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) return next();
    try {
      let html = cache.get(file);
      if (!html) {
        html = (await readFile(file, 'utf8')).replace(/chattrack/g, brand).replace(/Chattrack/g, brand.charAt(0).toUpperCase() + brand.slice(1));
        cache.set(file, html);
      }
      res.type('html').send(html);
    } catch {
      next();
    }
  };
}

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
  // Nome do produto por instalação (BRAND_NAME): as instalações de clientes
  // mostram "chatpipe"; sem a variável, fica "chattrack". Só nas páginas HTML.
  app.use(brandedHtml(path.join(__dirname, '..', 'public')));
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
