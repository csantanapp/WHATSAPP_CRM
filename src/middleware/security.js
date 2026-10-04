import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// CSP desligado aqui de propósito: o frontend hoje é HTML+JS inline em
// public/index.html e uma CSP default quebraria scripts/estilos inline.
// Reforçar isso faz parte da Fase 1 (quando o frontend for modularizado).
export const securityHeaders = helmet({ contentSecurityPolicy: false });

export const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // a Meta pode reenviar em rajada; limite generoso, só contra abuso
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
