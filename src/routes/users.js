import { Router } from 'express';
import { z } from 'zod';
import { listUsers, createUser, updateUser, findUserByEmail, setUserPassword, getUserById } from '../repositories/users.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../repositories/auditLog.js';

export const usersRouter = Router();

usersRouter.use(requireAuth, requireRole('admin'));

usersRouter.get('/', async (req, res) => {
  res.json(await listUsers(req.tenantId));
});

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.'),
  role: z.enum(['admin', 'supervisor', 'atendente']).default('atendente'),
});

usersRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'invalid_input', message: parsed.error.issues[0]?.message || 'Dados inválidos.' } });
  }
  const { name, email, password, role } = parsed.data;

  const existing = await findUserByEmail(req.tenantId, email);
  if (existing) {
    return res.status(409).json({ error: { code: 'email_taken', message: 'Já existe um usuário com esse e-mail.' } });
  }

  const user = await createUser(req.tenantId, { name, email, password, role });
  await logAudit({ tenantId: req.tenantId, userId: req.user.id, action: 'USER_CREATED', entityType: 'user', entityId: user.id, metadata: { email, role } });
  res.status(201).json(user);
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(['admin', 'supervisor', 'atendente']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

usersRouter.patch('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'invalid_input', message: 'Dados inválidos.' } });
  }
  if (Number(req.params.id) === req.user.id && parsed.data.status === 'disabled') {
    return res.status(400).json({ error: { code: 'cannot_disable_self', message: 'Você não pode desativar o próprio usuário.' } });
  }

  const user = await updateUser(req.tenantId, req.params.id, parsed.data);
  if (!user) return res.status(404).json({ error: { code: 'not_found', message: 'Usuário não encontrado.' } });

  await logAudit({ tenantId: req.tenantId, userId: req.user.id, action: 'USER_UPDATED', entityType: 'user', entityId: user.id, metadata: parsed.data });
  res.json(user);
});

const resetPasswordSchema = z.object({
  newPassword: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.'),
});

usersRouter.post('/:id/reset-password', async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'invalid_input', message: 'Senha inválida.' } });
  }
  const target = await getUserById(req.tenantId, req.params.id);
  if (!target) return res.status(404).json({ error: { code: 'not_found', message: 'Usuário não encontrado.' } });

  const user = await setUserPassword(req.tenantId, req.params.id, parsed.data.newPassword);
  await logAudit({ tenantId: req.tenantId, userId: req.user.id, action: 'USER_PASSWORD_RESET', entityType: 'user', entityId: user.id });
  res.json({ ok: true });
});
