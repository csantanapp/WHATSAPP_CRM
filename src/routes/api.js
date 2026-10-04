import { Router } from 'express';
import { query } from '../db/pool.js';
import {
  listContacts,
  createContact,
  getContactById,
  getContactConversations,
  updateContact,
  addTagToContact,
  removeTagFromContact,
} from '../repositories/contacts.js';
import {
  listConversationsByFunnel,
  moveConversationToStage,
  moveConversationToNextStage,
  moveConversationToFunnel,
  getConversationDetail,
  markConversationAsRead,
} from '../repositories/conversations.js';
import { listMessagesByConversation, insertMessage } from '../repositories/messages.js';
import { sendTextMessage, checkConnectionStatus } from '../whatsapp/client.js';
import { broadcast } from '../realtime.js';
import {
  listFlowsWithSteps,
  getFlowWithSteps,
  createFlow,
  updateFlow,
  deleteFlow,
  replaceFlowSteps,
  setFlowActive,
} from '../repositories/automations.js';
import {
  listFunnelsWithStages,
  createFunnel,
  createStage,
  renameStage,
  deleteStage,
  moveStage,
  renameFunnel,
  deleteFunnel,
  updateFunnelEntry,
  addDefaultTagToFunnel,
  removeDefaultTagFromFunnel,
  applyFunnelDefaultTagsToContact,
} from '../repositories/funnels.js';
import { getDashboardSummary, getRecentConversations } from '../repositories/dashboard.js';
import { getSetting, setSetting } from '../repositories/settings.js';
import { listTags, createTag, deleteTag } from '../repositories/tags.js';
import { getActivityLogForContact } from '../repositories/activityLog.js';

export const apiRouter = Router();

// Evita que uma rejeição numa rota async (ex: Postgres fora do ar) derrube o processo inteiro.
function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

apiRouter.get('/contacts', asyncHandler(async (req, res) => {
  res.json(await listContacts(req.tenantId, req.query.q, req.query.funnel_id));
}));

apiRouter.post('/contacts', asyncHandler(async (req, res) => {
  const { wa_id, name, phone_display, source, email } = req.body;
  if (!wa_id) return res.status(400).json({ error: 'wa_id (telefone) é obrigatório' });
  try {
    const contact = await createContact({ waId: wa_id, name, phoneDisplay: phone_display, source, email });
    res.status(201).json(contact);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um contato com esse número' });
    throw err;
  }
}));

apiRouter.get('/contacts/:id', asyncHandler(async (req, res) => {
  const contact = await getContactById(req.tenantId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contato não encontrado' });
  const conversations = await getContactConversations(req.params.id);
  res.json({ ...contact, conversations });
}));

apiRouter.get('/contacts/:id/history', asyncHandler(async (req, res) => {
  res.json(await getActivityLogForContact(req.params.id));
}));

apiRouter.patch('/contacts/:id', asyncHandler(async (req, res) => {
  res.json(await updateContact(req.params.id, req.body));
}));

apiRouter.post('/contacts/:id/tags', asyncHandler(async (req, res) => {
  if (!req.body.tag) return res.status(400).json({ error: 'tag é obrigatório' });
  res.json(await addTagToContact(req.params.id, req.body.tag));
}));

apiRouter.delete('/contacts/:id/tags/:tag', asyncHandler(async (req, res) => {
  res.json(await removeTagFromContact(req.params.id, req.params.tag));
}));

apiRouter.get('/funnels', asyncHandler(async (req, res) => {
  res.json(await listFunnelsWithStages(req.tenantId));
}));

apiRouter.post('/funnels', asyncHandler(async (req, res) => {
  const { name, color, welcome_message, stages, default_tags } = req.body;
  if (!name) return res.status(400).json({ error: 'name é obrigatório' });
  res.status(201).json(await createFunnel({ name, color, welcomeMessage: welcome_message, stages, defaultTags: default_tags }));
}));

apiRouter.post('/funnels/:id/default-tags', asyncHandler(async (req, res) => {
  if (!req.body.tag) return res.status(400).json({ error: 'tag é obrigatório' });
  res.json(await addDefaultTagToFunnel(req.params.id, req.body.tag));
}));

apiRouter.delete('/funnels/:id/default-tags/:tag', asyncHandler(async (req, res) => {
  res.json(await removeDefaultTagFromFunnel(req.params.id, req.params.tag));
}));

apiRouter.patch('/funnels/:id', asyncHandler(async (req, res) => {
  if (req.body.name !== undefined) await renameFunnel(req.params.id, req.body.name);
  if (req.body.welcome_message !== undefined) await updateFunnelEntry(req.params.id, { welcomeMessage: req.body.welcome_message });
  const result = await query('SELECT * FROM funnels WHERE id = $1', [req.params.id]);
  res.json(result.rows[0]);
}));

apiRouter.delete('/funnels/:id', asyncHandler(async (req, res) => {
  await deleteFunnel(req.params.id);
  res.status(204).end();
}));

apiRouter.post('/funnels/:id/stages', asyncHandler(async (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name é obrigatório' });
  res.status(201).json(await createStage(req.params.id, { name, color }));
}));

apiRouter.patch('/stages/:id', asyncHandler(async (req, res) => {
  res.json(await renameStage(req.params.id, { name: req.body.name, color: req.body.color }));
}));

apiRouter.delete('/stages/:id', asyncHandler(async (req, res) => {
  await deleteStage(req.params.id);
  res.status(204).end();
}));

apiRouter.patch('/stages/:id/move', asyncHandler(async (req, res) => {
  const { direction } = req.body; // 'up' | 'down'
  if (direction !== 'up' && direction !== 'down') return res.status(400).json({ error: 'direction deve ser "up" ou "down"' });
  res.json(await moveStage(req.params.id, direction));
}));

apiRouter.get('/dashboard/summary', asyncHandler(async (req, res) => {
  res.json(await getDashboardSummary(req.tenantId));
}));

apiRouter.get('/dashboard/recent-conversations', asyncHandler(async (req, res) => {
  res.json(await getRecentConversations(req.tenantId));
}));

apiRouter.get('/settings/whatsapp-status', asyncHandler(async (_req, res) => {
  const status = await checkConnectionStatus();
  const manualNumber = await getSetting('whatsapp_public_number');
  res.json({ ...status, manualPhoneNumber: manualNumber });
}));

// Permite cadastrar o número público do WhatsApp manualmente (só pra gerar os
// links wa.me das campanhas), sem precisar da API oficial da Meta já validada.
apiRouter.put('/settings/whatsapp-number', asyncHandler(async (req, res) => {
  const { phone_number } = req.body;
  await setSetting('whatsapp_public_number', phone_number || null);
  res.json({ manualPhoneNumber: phone_number || null });
}));

apiRouter.get('/funnels/:id/conversations', asyncHandler(async (req, res) => {
  res.json(await listConversationsByFunnel(req.params.id));
}));

apiRouter.get('/conversations/:id/messages', asyncHandler(async (req, res) => {
  res.json(await listMessagesByConversation(req.params.id));
}));

apiRouter.get('/conversations/:id', asyncHandler(async (req, res) => {
  const detail = await getConversationDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Conversa não encontrada' });
  res.json(detail);
}));

apiRouter.post('/conversations/:id/read', asyncHandler(async (req, res) => {
  const updated = await markConversationAsRead(req.params.id);
  broadcast({ type: 'conversation:stage_changed', conversation: updated });
  res.json(updated);
}));

apiRouter.patch('/conversations/:id/stage', asyncHandler(async (req, res) => {
  const { funnel_stage_id } = req.body;
  const updated = await moveConversationToStage(req.params.id, funnel_stage_id);
  broadcast({ type: 'conversation:stage_changed', conversation: updated });
  res.json(updated);
}));

apiRouter.post('/conversations/:id/advance-stage', asyncHandler(async (req, res) => {
  const updated = await moveConversationToNextStage(req.params.id);
  broadcast({ type: 'conversation:stage_changed', conversation: updated });
  res.json(updated);
}));

apiRouter.patch('/conversations/:id/funnel', asyncHandler(async (req, res) => {
  const { funnel_id, funnel_stage_id } = req.body;
  const updated = await moveConversationToFunnel(req.params.id, funnel_id, funnel_stage_id);
  if (funnel_id) await applyFunnelDefaultTagsToContact(funnel_id, updated.contact_id);
  broadcast({ type: 'conversation:stage_changed', conversation: updated });
  res.json(updated);
}));

// Envio manual de mensagem por um atendente (fora de qualquer automação).
apiRouter.post('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const conversationId = req.params.id;
  const { text } = req.body;

  const convResult = await query(
    `SELECT c.*, ct.wa_id FROM conversations c
     JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
    [conversationId]
  );
  const conversation = convResult.rows[0];
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada' });

  try {
    const sent = await sendTextMessage(conversation.wa_id, text);
    const saved = await insertMessage({
      conversationId,
      waMessageId: sent?.messages?.[0]?.id,
      direction: 'outbound',
      senderType: 'agent',
      body: text,
    });
    broadcast({ type: 'message:new', conversationId: Number(conversationId), message: saved });
    res.status(201).json(saved);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

apiRouter.get('/automation-flows', asyncHandler(async (req, res) => {
  res.json(await listFlowsWithSteps(req.tenantId, req.query.funnel_id));
}));

apiRouter.get('/automation-flows/:id', asyncHandler(async (req, res) => {
  const flow = await getFlowWithSteps(req.params.id);
  if (!flow) return res.status(404).json({ error: 'Fluxo não encontrado' });
  res.json(flow);
}));

apiRouter.post('/automation-flows', asyncHandler(async (req, res) => {
  const { name, funnel_id, trigger_type, trigger_config, steps } = req.body;
  const flow = await createFlow({ name, funnelId: funnel_id, triggerType: trigger_type, triggerConfig: trigger_config });
  if (steps && steps.length) await replaceFlowSteps(flow.id, steps);
  res.status(201).json(await getFlowWithSteps(flow.id));
}));

apiRouter.patch('/automation-flows/:id', asyncHandler(async (req, res) => {
  const { name, funnel_id, trigger_type, trigger_config, steps } = req.body;
  await updateFlow(req.params.id, { name, funnelId: funnel_id, triggerType: trigger_type, triggerConfig: trigger_config });
  if (steps) await replaceFlowSteps(req.params.id, steps);
  res.json(await getFlowWithSteps(req.params.id));
}));

apiRouter.delete('/automation-flows/:id', asyncHandler(async (req, res) => {
  await deleteFlow(req.params.id);
  res.status(204).end();
}));

apiRouter.patch('/automation-flows/:id/active', asyncHandler(async (req, res) => {
  res.json(await setFlowActive(req.params.id, req.body.is_active));
}));

apiRouter.get('/tags', asyncHandler(async (req, res) => {
  res.json(await listTags(req.tenantId));
}));

apiRouter.post('/tags', asyncHandler(async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'name é obrigatório' });
  res.status(201).json(await createTag(req.body.name, req.body.color));
}));

apiRouter.delete('/tags/:id', asyncHandler(async (req, res) => {
  await deleteTag(req.params.id);
  res.status(204).end();
}));
