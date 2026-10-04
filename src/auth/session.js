import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { pool } from '../db/pool.js';

const PgSession = connectPgSimple(session);

// Cookie HttpOnly + SameSite=Lax (CSRF básico: navegador não manda em POST
// cross-site). Secure fica condicionado a produção pra não quebrar dev local
// sem HTTPS. Expira em 12h, renovado a cada requisição (rolling).
export function createSessionMiddleware() {
  return session({
    store: new PgSession({ pool, tableName: 'session' }),
    secret: process.env.SESSION_SECRET || 'dev-only-secret-troque-em-producao',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000,
    },
  });
}
