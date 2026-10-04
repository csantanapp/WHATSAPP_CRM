import { query } from '../db/pool.js';
import { sendTextMessage } from '../whatsapp/client.js';
import { insertMessage } from '../repositories/messages.js';
import { addTagToContact } from '../repositories/contacts.js';
import { moveConversationToStage } from '../repositories/conversations.js';
import { broadcast } from '../realtime.js';

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

// Executa passos em sequência até encontrar um que precise de resposta do contato.
async function runFlowFromStep({ flow, conversation, contact, step, run }) {
  // `cursor` é compartilhado com executeSteps para que o catch abaixo saiba
  // em qual passo o fluxo travou, mesmo com a reatribuição dentro do while.
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
  while (cursor.current) {
    const current = cursor.current;
    switch (current.step_type) {
      case 'send_message': {
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
      case 'move_stage': {
        const stageId = current.config?.funnel_stage_id;
        if (stageId) await moveConversationToStage(conversation.id, stageId);
        break;
      }
      case 'ask_question': {
        // Envia a pergunta e pausa o fluxo aguardando a resposta do contato.
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

    cursor.current = current.next_step_id ? await getStep(current.next_step_id) : null;
  }

  await updateRun(run.id, { currentStepId: null, status: 'completed' });
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
