import { query } from '../db/pool.js';
import { sendTextMessage } from '../whatsapp/client.js';
import { insertMessage } from '../repositories/messages.js';
import { addTagToContact } from '../repositories/contacts.js';
import { moveConversationToStage, assignConversation, setConversationStatus } from '../repositories/conversations.js';
import { createTask } from '../repositories/tasks.js';
import { pickNextRoundRobinUser } from '../services/distribution.js';
import { scheduleJob } from '../jobs/scheduledJobs.js';
import { broadcast } from '../realtime.js';
import { logger } from '../logger.js';
import { classifyForAutomation } from '../services/ai/AIService.js';

async function isFirstMessageOfConversation(conversationId) {
  const result = await query(
    'SELECT count(*)::int AS count FROM messages WHERE conversation_id = $1',
    [conversationId]
  );
  return result.rows[0].count <= 1;
}

// Um fluxo se aplica a uma conversa se for genérico (funnel_id nulo) ou se for
// especificamente do funil em que a conversa está agora.
async function getActiveFlowsByTrigger(triggerType, funnelId) {
  const result = await query(
    `SELECT * FROM automation_flows
     WHERE trigger_type = $1 AND is_active = true AND (funnel_id IS NULL OR funnel_id = $2)`,
    [triggerType, funnelId || null]
  );
  return result.rows;
}

async function getFirstStep(flowId) {
  const result = await query(
    'SELECT * FROM automation_flow_steps WHERE automation_flow_id = $1 ORDER BY position ASC LIMIT 1',
    [flowId]
  );
  return result.rows[0];
}

async function getStep(stepId) {
  const result = await query('SELECT * FROM automation_flow_steps WHERE id = $1', [stepId]);
  return result.rows[0];
}

async function createRun(flowId, conversationId, currentStepId, status) {
  const result = await query(
    `INSERT INTO automation_runs (automation_flow_id, conversation_id, current_step_id, status)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [flowId, conversationId, currentStepId, status]
  );
  return result.rows[0];
}

async function updateRun(runId, { currentStepId, status }) {
  const result = await query(
    `UPDATE automation_runs SET current_step_id = $2, status = $3,
       finished_at = CASE WHEN $3 IN ('completed','stopped') THEN now() ELSE finished_at END
     WHERE id = $1 RETURNING *`,
    [runId, currentStepId, status]
  );
  return result.rows[0];
}

async function isOptedOut(contactId) {
  const result = await query('SELECT opted_out_at FROM contacts WHERE id = $1', [contactId]);
  return result.rows[0]?.opted_out_at != null;
}

// Executa passos em sequência até encontrar um que precise de resposta do
// contato (ask_question) ou de tempo (wait) — os dois pausam a run.
async function runFlowFromStep({ flow, conversation, contact, step, run }) {
  const cursor = { current: step };

  try {
    await executeSteps({ flow, conversation, contact, run, cursor });
  } catch (err) {
    // Evita deixar a run travada em "running" para sempre quando um passo falha
    // (ex: erro de credencial/permissão na Graph API).
    await updateRun(run.id, { currentStepId: cursor.current?.id ?? null, status: 'stopped' });
    throw err;
  }
}

async function executeSteps({ flow, conversation, contact, run, cursor }) {
  let iterations = 0;
  while (cursor.current) {
    iterations += 1;
    if (iterations > 50) {
      // Protege contra ciclo infinito criado por um nó "Repetir" sem saída —
      // para a run em vez de travar o worker pra sempre.
      logger.error('automation_loop_guard_triggered', { flowId: flow.id, runId: run.id, stepId: cursor.current.id });
      await updateRun(run.id, { currentStepId: cursor.current.id, status: 'stopped' });
      return;
    }
    const current = cursor.current;
    let nextOverride; // usado pelo 'condition'/'classify_ai' pra escolher o ramo certo

    switch (current.step_type) {
      case 'send_message': {
        if (await isOptedOut(contact.id)) {
          logger.info('automation_skip_opted_out', { contactId: contact.id, stepId: current.id });
          break;
        }
        const text = current.config?.text || '';
        const sent = await sendTextMessage(contact.wa_id, text);
        const saved = await insertMessage({
          conversationId: conversation.id,
          waMessageId: sent?.messages?.[0]?.id,
          direction: 'outbound',
          senderType: 'automation',
          body: text,
          automationFlowId: flow.id,
        });
        broadcast({ type: 'message:new', conversationId: conversation.id, message: saved });
        break;
      }
      case 'add_tag': {
        const tag = current.config?.tag;
        if (tag) await addTagToContact(contact.id, tag);
        break;
      }
      case 'remove_tag': {
        const tag = current.config?.tag;
        if (tag) {
          await query(
            `UPDATE contacts SET tags = array_remove(tags, $2), updated_at = now() WHERE id = $1`,
            [contact.id, tag]
          );
        }
        break;
      }
      case 'move_stage': {
        const stageId = current.config?.funnel_stage_id;
        if (stageId) await moveConversationToStage(conversation.id, stageId);
        break;
      }
      case 'assign_user': {
        const userId = current.config?.user_id;
        if (userId) await assignConversation(conversation.id, userId);
        break;
      }
      case 'assign_round_robin': {
        const userId = await pickNextRoundRobinUser(flow.tenant_id);
        if (userId) await assignConversation(conversation.id, userId);
        else logger.info('automation_round_robin_sem_participantes', { flowId: flow.id });
        break;
      }
      case 'create_task': {
        await createTask({
          contactId: contact.id,
          conversationId: conversation.id,
          assignedUserId: current.config?.assigned_user_id || null,
          title: current.config?.title || 'Follow-up',
          description: current.config?.description || null,
          dueAt: current.config?.due_in_hours
            ? new Date(Date.now() + current.config.due_in_hours * 3600 * 1000)
            : null,
        });
        break;
      }
      case 'close_conversation': {
        await setConversationStatus(conversation.id, 'closed');
        break;
      }
      case 'condition': {
        const result = await evaluateCondition(current.config, { contact, conversation });
        nextOverride = result ? current.next_step_id_true : current.next_step_id_false;
        break;
      }
      case 'classify_ai': {
        const transcriptResult = await query(
          `SELECT direction, body FROM messages WHERE conversation_id = $1 AND kind = 'message' ORDER BY created_at DESC LIMIT 20`,
          [conversation.id]
        );
        const transcript = transcriptResult.rows.reverse()
          .map((m) => (m.direction === 'inbound' ? 'Cliente: ' : 'Atendente: ') + (m.body || '[mídia]'))
          .join('\n');
        const result = await classifyForAutomation(flow.tenant_id, { question: current.config?.question || '', transcript });
        nextOverride = result ? current.next_step_id_true : current.next_step_id_false;
        break;
      }
      case 'wait': {
        // Pausa a run e agenda a retomada — nenhum setTimeout em memória
        // (sobrevive a restart/redeploy do container).
        const minutes = current.config?.minutes || 60;
        const runAt = new Date(Date.now() + minutes * 60 * 1000);
        await scheduleJob('automation_resume', runAt, { runId: run.id, stepId: current.id });
        await updateRun(run.id, { currentStepId: current.id, status: 'waiting_delay' });
        return;
      }
      case 'ask_question': {
        if (await isOptedOut(contact.id)) {
          await updateRun(run.id, { currentStepId: null, status: 'stopped' });
          return;
        }
        const text = current.config?.text || '';
        const sent = await sendTextMessage(contact.wa_id, text);
        const saved = await insertMessage({
          conversationId: conversation.id,
          waMessageId: sent?.messages?.[0]?.id,
          direction: 'outbound',
          senderType: 'automation',
          body: text,
          automationFlowId: flow.id,
        });
        broadcast({ type: 'message:new', conversationId: conversation.id, message: saved });
        await updateRun(run.id, { currentStepId: current.id, status: 'waiting_reply' });
        return;
      }
      default:
        break;
    }

    const nextId = nextOverride !== undefined ? nextOverride : current.next_step_id;
    cursor.current = nextId ? await getStep(nextId) : null;
  }

  await updateRun(run.id, { currentStepId: null, status: 'completed' });
}

async function evaluateCondition(config, { contact, conversation }) {
  const check = config?.check;
  if (check === 'tag_exists') {
    return (contact.tags || []).includes(config.tag);
  }
  if (check === 'stage_equals') {
    return conversation.funnel_stage_id === config.funnel_stage_id;
  }
  return false;
}

export async function runTriggersForInboundMessage({ conversation, contact, message }) {
  // Trigger: primeira mensagem da conversa dispara fluxos configurados como "first_message".
  if (await isFirstMessageOfConversation(conversation.id)) {
    const flows = await getActiveFlowsByTrigger('first_message', conversation.funnel_id);
    for (const flow of flows) {
      const firstStep = await getFirstStep(flow.id);
      if (!firstStep) continue;
      const run = await createRun(flow.id, conversation.id, firstStep.id, 'running');
      await runFlowFromStep({ flow, conversation, contact, step: firstStep, run });
    }
    return;
  }

  // Se há uma automação aguardando resposta nesta conversa, continua o fluxo a partir dela.
  const waitingRun = await query(
    `SELECT * FROM automation_runs WHERE conversation_id = $1 AND status = 'waiting_reply'
     ORDER BY started_at DESC LIMIT 1`,
    [conversation.id]
  );
  const run = waitingRun.rows[0];

  if (!run) {
    // Sem fluxo pendente: verifica se a mensagem contém a palavra-chave de algum
    // fluxo do tipo "keyword" válido pra este funil, e dispara um novo se sim.
    const keywordFlows = await getActiveFlowsByTrigger('keyword', conversation.funnel_id);
    const matched = keywordFlows.find((f) => {
      const keyword = f.trigger_config?.keyword;
      return keyword && (message.body || '').toLowerCase().includes(keyword.toLowerCase());
    });
    if (!matched) return;

    const firstStep = await getFirstStep(matched.id);
    if (!firstStep) return;
    const newRun = await createRun(matched.id, conversation.id, firstStep.id, 'running');
    await runFlowFromStep({ flow: matched, conversation, contact, step: firstStep, run: newRun });
    return;
  }

  await query(
    'INSERT INTO automation_run_answers (automation_run_id, step_id, answer) VALUES ($1,$2,$3)',
    [run.id, run.current_step_id, message.body]
  );

  const step = await getStep(run.current_step_id);
  const nextStep = step?.next_step_id ? await getStep(step.next_step_id) : null;
  const flowResult = await query('SELECT * FROM automation_flows WHERE id = $1', [run.automation_flow_id]);
  const flow = flowResult.rows[0];

  if (!nextStep) {
    await updateRun(run.id, { currentStepId: null, status: 'completed' });
    return;
  }

  await updateRun(run.id, { currentStepId: nextStep.id, status: 'running' });
  await runFlowFromStep({ flow, conversation, contact, step: nextStep, run });
}

// Gatilho: tag adicionada a um contato (chamado pela rota de tags em api.js).
export async function runTriggersForTagAdded({ conversation, contact, tag }) {
  if (!conversation) return;
  const flows = await getActiveFlowsByTrigger('tag_added', conversation.funnel_id);
  for (const flow of flows) {
    if (flow.trigger_config?.tag && flow.trigger_config.tag !== tag) continue;
    const firstStep = await getFirstStep(flow.id);
    if (!firstStep) continue;
    const run = await createRun(flow.id, conversation.id, firstStep.id, 'running');
    await runFlowFromStep({ flow, conversation, contact, step: firstStep, run });
  }
}

// Gatilho: conversa entrou numa etapa de funil (chamado pela rota de mover etapa).
export async function runTriggersForStageEntered({ conversation, contact }) {
  const flows = await getActiveFlowsByTrigger('stage_entered', conversation.funnel_id);
  for (const flow of flows) {
    if (flow.trigger_config?.funnel_stage_id && flow.trigger_config.funnel_stage_id !== conversation.funnel_stage_id) continue;
    const firstStep = await getFirstStep(flow.id);
    if (!firstStep) continue;
    const run = await createRun(flow.id, conversation.id, firstStep.id, 'running');
    await runFlowFromStep({ flow, conversation, contact, step: firstStep, run });
  }
}

// Retomada de uma run pausada em 'wait' — chamado pelo worker de jobs agendados.
export async function resumeRunAfterWait(runId) {
  const runResult = await query('SELECT * FROM automation_runs WHERE id = $1', [runId]);
  const run = runResult.rows[0];
  if (!run || run.status !== 'waiting_delay') return; // já foi adiante por outro motivo

  const step = await getStep(run.current_step_id);
  const nextId = step?.next_step_id;
  if (!nextId) {
    await updateRun(run.id, { currentStepId: null, status: 'completed' });
    return;
  }

  const flowResult = await query('SELECT * FROM automation_flows WHERE id = $1', [run.automation_flow_id]);
  const flow = flowResult.rows[0];
  const convResult = await query('SELECT * FROM conversations WHERE id = $1', [run.conversation_id]);
  const conversation = convResult.rows[0];
  if (!conversation) return;
  const contactResult = await query('SELECT * FROM contacts WHERE id = $1', [conversation.contact_id]);
  const contact = contactResult.rows[0];

  const nextStep = await getStep(nextId);
  await updateRun(run.id, { currentStepId: nextStep.id, status: 'running' });
  await runFlowFromStep({ flow, conversation, contact, step: nextStep, run });
}
