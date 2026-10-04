import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { findUserByEmailAnyTenant, touchLastLogin, setUserPassword } from '../repositories/users.js';
import { verifyPassword } from '../auth/password.js';
import { logAudit } from '../repositories/auditLog.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

// 5 tentativas a cada 15min por IP+email — mensagem genérica, não revela se
// o e-mail existe ou se foi a senha que errou (evita enumeração de contas).
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${req.ip}:${(req.body?.email || '').toLowerCase()}`,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: { code: 'too_many_attempts', message: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' } });
  },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/login', loginRateLimit, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'invalid_input', message: 'E-mail e senha são obrigatórios.' } });
  }
  const { email, password } = parsed.data;

  const user = await findUserByEmailAnyTenant(email);
  const genericError = () =>
    res.status(401).json({ error: { code: 'invalid_credentials', message: 'E-mail ou senha inválidos.' } });

  if (!user || user.status !== 'active' || user.tenant_status !== 'active') {
    await logAudit({ action: 'LOGIN_FAILED', metadata: { email }, ip: req.ip });
    return genericError();
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    await logAudit({ tenantId: user.tenant_id, action: 'LOGIN_FAILED', metadata: { email }, ip: req.ip });
    return genericError();
  }

  req.session.user = {
    id: user.id,
    tenantId: user.tenant_id,
    name: user.name,
    email: user.email,
    role: user.role,
    isPlatformAdmin: user.is_platform_admin,
  };
  await touchLastLogin(user.id);
  await logAudit({ tenantId: user.tenant_id, userId: user.id, action: 'LOGIN', ip: req.ip });

  res.json({ user: req.session.user });
});

authRouter.post('/logout', requireAuth, async (req, res) => {
  const { tenantId, id } = req.user;
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    logAudit({ tenantId, userId: id, action: 'LOGOUT' }).catch(() => {});
    res.json({ ok: true });
  });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'A nova senha precisa ter pelo menos 8 caracteres.'),
});

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'invalid_input', message: parsed.error.issues[0]?.message || 'Dados inválidos.' } });
  }

  const { currentPassword, newPassword } = parsed.data;

  const full = await findUserByEmailAnyTenant(req.user.email);
  const ok = await verifyPassword(currentPassword, full.password_hash);
  if (!ok) {
    return res.status(400).json({ error: { code: 'wrong_password', message: 'Senha atual incorreta.' } });
  }

  await setUserPassword(req.tenantId, req.user.id, newPassword);
  await logAudit({ tenantId: req.tenantId, userId: req.user.id, action: 'PASSWORD_CHANGED' });
  res.json({ ok: true });
});
