import { Router } from 'express';
import { query } from '../db/pool.js';
import {
  listContacts,
  createContact,
  getContactById,
  getContactConversations,
  updateContact,
  deleteContact,
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
  assignConversation,
  unassignConversation,
  setConversationStatus,
  setConversationPriority,
  markFirstResponseIfNeeded,
  isWindowOpen,
  touchConversation,
  listInboxConversations,
  getInboxCounts,
} from '../repositories/conversations.js';
import { listMessagesByConversation, insertMessage, insertInternalNote } from '../repositories/messages.js';
import { listQuickReplies, createQuickReply, updateQuickReply, deleteQuickReply } from '../repositories/quickReplies.js';
import {
  createOpportunity,
  listOpportunities,
  getOpportunityById,
  updateOpportunity,
  markOpportunityWon,
  markOpportunityLost,
  listLossReasons,
  getOpportunitySummary,
  getRevenueBySource,
} from '../repositories/opportunities.js';
import {
  createTask,
  listTasksForUser,
  listTasksForContact,
  completeTask,
  cancelTask,
} from '../repositories/tasks.js';
import { getSourceForConversation } from '../repositories/conversationSources.js';
import { runTriggersForTagAdded, runTriggersForStageEntered } from '../automation/engine.js';
import { getDistributionRule, upsertDistributionRule } from '../services/distribution.js';
import { summarizeConversation, getLatestInsight, getAiSettings, updateAiSettings, AI_PROVIDERS } from '../services/ai/AIService.js';
import { runRadarNow } from '../jobs/dailyRadarJob.js';
import multer from 'multer';
import { readFile } from 'node:fs/promises';
import { mediaFilePath, saveMediaFile } from '../services/mediaStorage.js';
import { uploadMedia, sendMediaMessage } from '../whatsapp/client.js';
import { requireRole } from '../middleware/auth.js';
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

apiRouter.delete('/contacts/:id', requireRole('admin', 'supervisor'), asyncHandler(async (req, res) => {
  const deleted = await deleteContact(req.tenantId, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Contato não encontrado' });
  res.status(204).end();
}));

apiRouter.post('/contacts/:id/tags', asyncHandler(async (req, res) => {
  if (!req.body.tag) return res.status(400).json({ error: 'tag é obrigatório' });
  const contact = await addTagToContact(req.params.id, req.body.tag);
  res.json(contact);

  // Gatilho de automação "tag_added" — roda depois de responder, não bloqueia a requisição.
  const convResult = await query(
    "SELECT * FROM conversations WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1",
    [req.params.id]
  );
  const conversation = convResult.rows[0];
  if (conversation) {
    runTriggersForTagAdded({ conversation, contact, tag: req.body.tag }).catch((err) => {
      console.error('Falha no gatilho tag_added:', err.message);
    });
  }
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
  res.json(await listConversationsByFunnel(req.params.id, req.user));
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

  const contactResult = await query('SELECT * FROM contacts WHERE id = $1', [updated.contact_id]);
  runTriggersForStageEntered({ conversation: updated, contact: contactResult.rows[0] }).catch((err) => {
    console.error('Falha no gatilho stage_entered:', err.message);
  });
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

  // Janela de 24h: mensagem livre só é permitida se o contato escreveu nas
  // últimas 24h. Validado SEMPRE no backend — o frontend pode mostrar o aviso
  // antes, mas não é confiável sozinho (ver seção 21 do roadmap da Fase 2).
  const windowOpen = await isWindowOpen(conversationId);
  if (!windowOpen) {
    return res.status(422).json({
      error: { code: 'WINDOW_CLOSED', message: 'A janela de 24h desse contato está fechada — envie um template aprovado pela Meta.' },
    });
  }

  try {
    const sent = await sendTextMessage(conversation.wa_id, text);
    const saved = await insertMessage({
      conversationId,
      waMessageId: sent?.messages?.[0]?.id,
      direction: 'outbound',
      senderType: 'agent',
      body: text,
    });
    await touchConversation(conversationId, { incrementUnread: false, isInbound: false });
    await markFirstResponseIfNeeded(conversationId);
    broadcast({ type: 'message:new', conversationId: Number(conversationId), message: saved });
    res.status(201).json(saved);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// --- Atendimento: atribuição, status, prioridade, notas internas ---

apiRouter.patch('/conversations/:id/assign', asyncHandler(async (req, res) => {
  const userId = req.body.user_id ?? req.user.id; // sem user_id = "assumir pra mim"
  const updated = await assignConversation(req.params.id, userId);
  if (!updated) return res.status(404).json({ error: 'Conversa não encontrada' });
  broadcast({ type: 'conversation:assigned', conversation: updated });
  res.json(updated);
}));

apiRouter.patch('/conversations/:id/unassign', asyncHandler(async (req, res) => {
  const updated = await unassignConversation(req.params.id);
  if (!updated) return res.status(404).json({ error: 'Conversa não encontrada' });
  broadcast({ type: 'conversation:assigned', conversation: updated });
  res.json(updated);
}));

apiRouter.patch('/conversations/:id/status', asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['open', 'pending', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'status deve ser open, pending ou closed' });
  }
  const updated = await setConversationStatus(req.params.id, status);
  if (!updated) return res.status(404).json({ error: 'Conversa não encontrada' });
  broadcast({ type: 'conversation:updated', conversation: updated });
  res.json(updated);

  // Resumo automático ao fechar — não bloqueia a resposta, nunca quebra o fluxo.
  if (status === 'closed') {
    summarizeConversation(req.tenantId, req.params.id).catch((err) => {
      console.error('Falha ao gerar resumo automático:', err.message);
    });
  }
}));

// --- IA ---

apiRouter.post('/conversations/:id/summarize', asyncHandler(async (req, res) => {
  const insight = await summarizeConversation(req.tenantId, req.params.id);
  if (!insight) return res.status(503).json({ error: { code: 'ai_unavailable', message: 'Não foi possível gerar o resumo agora (limite mensal atingido ou conversa sem mensagens).' } });
  res.json(insight);
}));

apiRouter.get('/conversations/:id/insight', asyncHandler(async (req, res) => {
  res.json(await getLatestInsight(req.params.id));
}));

apiRouter.get('/ai/providers', requireRole('admin'), asyncHandler(async (_req, res) => {
  res.json(Object.entries(AI_PROVIDERS).map(([id, def]) => ({ id, label: def.label })));
}));

apiRouter.get('/ai/settings', requireRole('admin'), asyncHandler(async (req, res) => {
  res.json(await getAiSettings(req.tenantId));
}));

apiRouter.put('/ai/settings', requireRole('admin'), asyncHandler(async (req, res) => {
  const { provider, summarize_enabled, radar_enabled, monthly_limit, api_key } = req.body;
  try {
    res.json(await updateAiSettings(req.tenantId, {
      provider, summarizeEnabled: summarize_enabled, radarEnabled: radar_enabled, monthlyLimit: monthly_limit, apiKey: api_key,
    }));
  } catch (err) {
    res.status(500).json({ error: { code: 'save_failed', message: err.message } });
  }
}));

apiRouter.get('/ai/radar/latest', asyncHandler(async (req, res) => {
  const result = await query(
    'SELECT * FROM daily_radar_results WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1',
    [req.tenantId]
  );
  res.json(result.rows[0] || null);
}));

apiRouter.post('/ai/radar/run', requireRole('admin', 'supervisor'), asyncHandler(async (req, res) => {
  const result = await runRadarNow(req.tenantId);
  res.status(201).json(result);
}));

apiRouter.patch('/conversations/:id/priority', asyncHandler(async (req, res) => {
  const updated = await setConversationPriority(req.params.id, !!req.body.is_priority);
  if (!updated) return res.status(404).json({ error: 'Conversa não encontrada' });
  broadcast({ type: 'conversation:updated', conversation: updated });
  res.json(updated);
}));

// Nota interna — nunca passa pela Graph API, nunca atualiza a janela de 24h.
apiRouter.post('/conversations/:id/notes', asyncHandler(async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text é obrigatório' });
  const saved = await insertInternalNote({ conversationId: req.params.id, authorUserId: req.user.id, body: text });
  broadcast({ type: 'message:new', conversationId: Number(req.params.id), message: saved });
  res.status(201).json(saved);
}));

// --- Respostas rápidas ---

apiRouter.get('/quick-replies', asyncHandler(async (req, res) => {
  res.json(await listQuickReplies(req.tenantId));
}));

apiRouter.post('/quick-replies', asyncHandler(async (req, res) => {
  const { shortcut, title, body } = req.body;
  if (!shortcut || !title || !body) return res.status(400).json({ error: 'shortcut, title e body são obrigatórios' });
  try {
    res.status(201).json(await createQuickReply(req.tenantId, { shortcut, title, body, createdBy: req.user.id }));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma resposta rápida com esse atalho' });
    throw err;
  }
}));

apiRouter.patch('/quick-replies/:id', asyncHandler(async (req, res) => {
  res.json(await updateQuickReply(req.tenantId, req.params.id, req.body));
}));

apiRouter.delete('/quick-replies/:id', requireRole('admin', 'supervisor'), asyncHandler(async (req, res) => {
  await deleteQuickReply(req.tenantId, req.params.id);
  res.status(204).end();
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

// --- Origem da conversa ---

apiRouter.get('/conversations/:id/source', asyncHandler(async (req, res) => {
  const source = await getSourceForConversation(req.params.id);
  res.json(source || null);
}));

// --- Oportunidades ---

apiRouter.get('/opportunities', asyncHandler(async (req, res) => {
  res.json(await listOpportunities(req.tenantId, { status: req.query.status, contactId: req.query.contact_id }));
}));

apiRouter.get('/opportunities/summary', asyncHandler(async (req, res) => {
  res.json(await getOpportunitySummary(req.tenantId));
}));

apiRouter.get('/opportunities/revenue-by-source', asyncHandler(async (req, res) => {
  res.json(await getRevenueBySource(req.tenantId));
}));

apiRouter.get('/loss-reasons', asyncHandler(async (req, res) => {
  res.json(await listLossReasons(req.tenantId));
}));

apiRouter.post('/opportunities', asyncHandler(async (req, res) => {
  const { contact_id, conversation_id, funnel_id, stage_id, title, value, product, owner_user_id, expected_close_date } = req.body;
  if (!contact_id || !title) return res.status(400).json({ error: 'contact_id e title são obrigatórios' });
  const opp = await createOpportunity({
    contactId: contact_id, conversationId: conversation_id, funnelId: funnel_id, stageId: stage_id,
    title, value, product, ownerUserId: owner_user_id || req.user.id, expectedCloseDate: expected_close_date,
  });
  res.status(201).json(opp);
}));

apiRouter.get('/opportunities/:id', asyncHandler(async (req, res) => {
  const opp = await getOpportunityById(req.tenantId, req.params.id);
  if (!opp) return res.status(404).json({ error: 'Oportunidade não encontrada' });
  res.json(opp);
}));

apiRouter.patch('/opportunities/:id', asyncHandler(async (req, res) => {
  const { title, value, product, stage_id, owner_user_id, expected_close_date } = req.body;
  const updated = await updateOpportunity(req.tenantId, req.params.id, {
    title, value, product, stageId: stage_id, ownerUserId: owner_user_id, expectedCloseDate: expected_close_date,
  });
  if (!updated) return res.status(404).json({ error: 'Oportunidade não encontrada' });
  res.json(updated);
}));

apiRouter.post('/opportunities/:id/won', asyncHandler(async (req, res) => {
  const updated = await markOpportunityWon(req.tenantId, req.params.id, req.body.value);
  if (!updated) return res.status(404).json({ error: 'Oportunidade não encontrada' });
  broadcast({ type: 'opportunity:updated', opportunity: updated });
  res.json(updated);
}));

apiRouter.post('/opportunities/:id/lost', asyncHandler(async (req, res) => {
  if (!req.body.loss_reason_id) return res.status(400).json({ error: 'loss_reason_id é obrigatório' });
  const updated = await markOpportunityLost(req.tenantId, req.params.id, req.body.loss_reason_id);
  if (!updated) return res.status(404).json({ error: 'Oportunidade não encontrada' });
  broadcast({ type: 'opportunity:updated', opportunity: updated });
  res.json(updated);
}));

// --- Tarefas / follow-up ---

apiRouter.get('/tasks/mine', asyncHandler(async (req, res) => {
  res.json(await listTasksForUser(req.tenantId, req.user.id));
}));

apiRouter.get('/contacts/:id/tasks', asyncHandler(async (req, res) => {
  res.json(await listTasksForContact(req.params.id));
}));

apiRouter.post('/tasks', asyncHandler(async (req, res) => {
  const { contact_id, conversation_id, opportunity_id, assigned_user_id, title, description, due_at } = req.body;
  if (!title) return res.status(400).json({ error: 'title é obrigatório' });
  const task = await createTask({
    contactId: contact_id, conversationId: conversation_id, opportunityId: opportunity_id,
    assignedUserId: assigned_user_id || req.user.id, title, description, dueAt: due_at, createdBy: req.user.id,
  });
  res.status(201).json(task);
}));

apiRouter.post('/tasks/:id/complete', asyncHandler(async (req, res) => {
  const updated = await completeTask(req.tenantId, req.params.id);
  if (!updated) return res.status(404).json({ error: 'Tarefa não encontrada' });
  res.json(updated);
}));

apiRouter.post('/tasks/:id/cancel', asyncHandler(async (req, res) => {
  const updated = await cancelTask(req.tenantId, req.params.id);
  if (!updated) return res.status(404).json({ error: 'Tarefa não encontrada' });
  res.json(updated);
}));

// --- Distribuição automática (round-robin) ---

apiRouter.get('/distribution-rule', asyncHandler(async (req, res) => {
  res.json(await getDistributionRule(req.tenantId) || { mode: 'manual', participant_user_ids: [], is_active: false });
}));

apiRouter.put('/distribution-rule', requireRole('admin', 'supervisor'), asyncHandler(async (req, res) => {
  const { mode, participant_user_ids, is_active } = req.body;
  if (mode && !['manual', 'round_robin'].includes(mode)) {
    return res.status(400).json({ error: 'mode deve ser manual ou round_robin' });
  }
  const rule = await upsertDistributionRule(req.tenantId, {
    mode: mode || 'manual', participantUserIds: participant_user_ids, isActive: is_active,
  });
  res.json(rule);
}));

// --- Mídia ---

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } }); // 16MB, teto da própria Meta

apiRouter.get('/media/:tenantId/:filename', asyncHandler(async (req, res) => {
  if (String(req.tenantId) !== String(req.params.tenantId)) {
    return res.status(403).json({ error: { code: 'forbidden', message: 'Mídia de outro tenant.' } });
  }
  const filePath = mediaFilePath(req.params.tenantId, req.params.filename);
  if (!filePath) return res.status(400).json({ error: 'Nome de arquivo inválido' });
  try {
    const buffer = await readFile(filePath);
    res.send(buffer);
  } catch {
    res.status(404).json({ error: 'Arquivo não encontrado' });
  }
}));

function graphMediaTypeFor(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

apiRouter.post('/conversations/:id/media', upload.single('file'), asyncHandler(async (req, res) => {
  const conversationId = req.params.id;
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  const windowOpen = await isWindowOpen(conversationId);
  if (!windowOpen) {
    return res.status(422).json({ error: { code: 'WINDOW_CLOSED', message: 'Janela de 24h fechada — não é possível enviar mídia livre.' } });
  }

  const convResult = await query(
    `SELECT c.*, ct.wa_id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
    [conversationId]
  );
  const conversation = convResult.rows[0];
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada' });

  const graphType = graphMediaTypeFor(req.file.mimetype);

  try {
    const metaMediaId = await uploadMedia(req.file.buffer, req.file.mimetype, req.file.originalname);
    const sent = await sendMediaMessage(conversation.wa_id, metaMediaId, graphType, req.body.caption);

    // Salva uma cópia local também (pra exibir no histórico sem depender da
    // URL temporária da Meta, que expira).
    const { servePath } = await saveMediaFile(req.tenantId, req.file.buffer, req.file.mimetype);

    const saved = await insertMessage({
      conversationId,
      waMessageId: sent?.messages?.[0]?.id,
      direction: 'outbound',
      senderType: 'agent',
      body: req.body.caption || null,
      mediaUrl: servePath,
      mediaType: req.file.mimetype,
      mediaFilename: req.file.originalname,
      mediaSizeBytes: req.file.size,
    });
    await touchConversation(conversationId, { incrementUnread: false, isInbound: false });
    broadcast({ type: 'message:new', conversationId: Number(conversationId), message: saved });
    res.status(201).json(saved);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// --- Inbox ---

apiRouter.get('/inbox/conversations', asyncHandler(async (req, res) => {
  const rows = await listInboxConversations(req.tenantId, req.user, {
    tab: req.query.tab,
    search: req.query.q,
    unreadOnly: req.query.unread === 'true',
    tag: req.query.tag,
  });
  res.json(rows);
}));

apiRouter.get('/inbox/counts', asyncHandler(async (req, res) => {
  res.json(await getInboxCounts(req.tenantId, req.user));
}));
