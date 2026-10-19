import { query } from '../db/pool.js';
import { insertMessage } from '../repositories/messages.js';
import { addTagToContact } from '../repositories/contacts.js';
import { moveConversationToStage, assignConversation, setConversationStatus } from '../repositories/conversations.js';
import { createTask } from '../repositories/tasks.js';
import { pickNextRoundRobinUser } from '../services/distribution.js';
import { scheduleJob } from '../jobs/scheduledJobs.js';
import { broadcast } from '../realtime.js';
import { logger } from '../logger.js';
import { classifyForAutomation } from '../services/ai/AIService.js';
import { sendQuestion, handleQuestionReply, sendText, knownAnswer, nextStepForAnswer } from './formQuestion.js';
import { renderTemplate } from './variables.js';
import { connectAgentToConversation } from './aiAgents.js';
import { renderPlain } from './variables.js';
import { getSheet, saveRecord, findRow } from '../integrations/google.js';
import { sheetExtras } from '../integrations/sheetsSync.js';

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

// Quantas vezes um fluxo pode passar a conversa pra outro em sequência, sem
// pausa (pergunta/aguardar) no meio — evita A → B → A → ... infinito.
const MAX_FLOW_HOPS = 5;

// Executa passos em sequência até encontrar um que precise de resposta do
// contato (ask_question) ou de tempo (wait) — os dois pausam a run.
// `hops` conta os "Conectar Automação" seguidos desta execução.
async function runFlowFromStep({ flow, conversation, contact, step, run, hops = 0 }) {
  const cursor = { current: step };

  try {
    await executeSteps({ flow, conversation, contact, run, cursor, hops });
  } catch (err) {
    // Evita deixar a run travada em "running" para sempre quando um passo falha
    // (ex: erro de credencial/permissão na Graph API).
    await updateRun(run.id, { currentStepId: cursor.current?.id ?? null, status: 'stopped' });
    throw err;
  }
}

async function executeSteps({ flow, conversation, contact, run, cursor, hops = 0 }) {
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
    let logOutcome = null;

    switch (current.step_type) {
      case 'send_message': {
        if (await isOptedOut(contact.id)) {
          logger.info('automation_skip_opted_out', { contactId: contact.id, stepId: current.id });
          break;
        }
        const text = renderTemplate(current.config?.text || '', contact);
        const sent = await sendText(contact, text, conversation.id);
        const saved = await insertMessage({
          conversationId: conversation.id,
          waMessageId: sent?.messages?.[0]?.id || sent?.message_id,
          direction: 'outbound',
          senderType: 'automation',
          body: text,
          automationFlowId: flow.id,
          automationStepId: current.id,
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
        logOutcome = result ? 'true' : 'false';
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
        logOutcome = result ? 'true' : 'false';
        break;
      }
      case 'wait': {
        // Pausa a run e agenda a retomada — nenhum setTimeout em memória
        // (sobrevive a restart/redeploy do container).
        const minutes = current.config?.minutes || 60;
        const runAt = new Date(Date.now() + minutes * 60 * 1000);
        await logStep(flow.id, current.id, run.id, conversation.id, null);
        await scheduleJob('automation_resume', runAt, { runId: run.id, stepId: current.id });
        await updateRun(run.id, { currentStepId: current.id, status: 'waiting_delay' });
        return;
      }
      case 'ask_question': {
        if (await isOptedOut(contact.id)) {
          await updateRun(run.id, { currentStepId: null, status: 'stopped' });
          return;
        }
        // Lead já conhecido: não pergunta de novo, segue (pelo ramo da opção
        // que ele já tinha escolhido, se o nó ramifica por opção).
        const known = knownAnswer(contact, current.config);
        if (known !== null) {
          nextOverride = nextStepForAnswer(current, known) || null;
          logOutcome = 'skipped_known';
          break;
        }
        await logStep(flow.id, current.id, run.id, conversation.id, null);
        await sendQuestion({ flow, conversation, contact, step: current });
        await updateRun(run.id, { currentStepId: current.id, status: 'waiting_reply' });
        return;
      }
      case 'sheets_save': {
        // "Salvar no Google Sheets": grava os dados do lead numa aba; com
        // "não duplicar", atualiza a linha do mesmo lead em vez de criar outra.
        logOutcome = await runSheetsSave(flow, contact, conversation, current.config || {});
        break;
      }
      case 'sheets_lookup': {
        // "Buscar no Google Sheets": procura uma linha e traz as colunas pra
        // ficha do lead ({{Coluna}} nas mensagens). Saídas: Encontrou / Não encontrou.
        const found = await runSheetsLookup(flow, contact, conversation, current.config || {});
        nextOverride = found === 'found' ? current.next_step_id_true : current.next_step_id_false;
        logOutcome = found === 'found' ? 'true' : (found === 'error' ? 'error' : 'false');
        break;
      }
      case 'start_ai_agent': {
        // "Conectar Agente IA": a partir daqui um agente de IA atende a
        // conversa. Nó terminal — o fluxo termina e a IA assume.
        if (await isOptedOut(contact.id)) {
          logOutcome = 'skipped';
          break;
        }
        const connected = await connectAgentToConversation({
          conversation, contact,
          agentId: current.config?.agent_id,
          replyNow: current.config?.reply_now !== false,
        });
        logOutcome = connected ? 'connected' : 'skipped';
        break;
      }
      case 'start_flow': {
        // "Conectar Automação": encerra esta run e começa o outro fluxo
        // do primeiro passo, na mesma conversa. Nó terminal (sem saída).
        const target = await getStartableFlow(current.config?.flow_id, flow);
        if (!target) {
          logOutcome = 'skipped';
          break;
        }
        if (hops >= MAX_FLOW_HOPS) {
          logger.error('automation_flow_hops_exceeded', { flowId: flow.id, targetFlowId: target.id, runId: run.id });
          logOutcome = 'skipped';
          break;
        }
        const firstStep = await getFirstStep(target.id);
        if (!firstStep) {
          logOutcome = 'skipped';
          break;
        }
        await logStep(flow.id, current.id, run.id, conversation.id, 'started_flow');
        await updateRun(run.id, { currentStepId: null, status: 'completed' });
        const newRun = await createRun(target.id, conversation.id, firstStep.id, 'running');
        await runFlowFromStep({ flow: target, conversation, contact, step: firstStep, run: newRun, hops: hops + 1 });
        return;
      }
      default:
        break;
    }

    await logStep(flow.id, current.id, run.id, conversation.id, logOutcome);
    const nextId = nextOverride !== undefined ? nextOverride : current.next_step_id;
    cursor.current = nextId ? await getStep(nextId) : null;
  }

  await updateRun(run.id, { currentStepId: null, status: 'completed' });
}

async function runSheetsSave(flow, contact, conversation, config) {
  try {
    const sheet = config.sheet_id ? await getSheet(flow.tenant_id, config.sheet_id) : null;
    if (!sheet || !config.tab) return 'skipped';
    const extra = await sheetExtras(contact, conversation);
    const record = {};
    for (const col of config.columns || []) {
      if (col?.header) record[col.header] = renderPlain(col.value || '', contact, extra);
    }
    const result = await saveRecord(flow.tenant_id, sheet.spreadsheet_id, config.tab, record, { matchColumn: config.match_column || null });
    return result.action; // appended | updated | skipped
  } catch (err) {
    logger.error('automation_sheets_save_failed', { flowId: flow.id, message: err.message });
    return 'error';
  }
}

async function runSheetsLookup(flow, contact, conversation, config) {
  try {
    const sheet = config.sheet_id ? await getSheet(flow.tenant_id, config.sheet_id) : null;
    if (!sheet || !config.tab || !config.search_column) return 'not_found';
    const value = renderPlain(config.search_value || '', contact, await sheetExtras(contact, conversation));
    if (!value) return 'not_found';
    const hit = await findRow(flow.tenant_id, sheet.spreadsheet_id, config.tab, config.search_column, value);
    if (!hit) return 'not_found';
    const wanted = (config.fields || []).length ? config.fields : Object.keys(hit.record);
    const toSave = {};
    for (const field of wanted) {
      const key = Object.keys(hit.record).find((h) => h.toLowerCase() === String(field).toLowerCase());
      if (key) toSave[key] = String(hit.record[key] ?? '');
    }
    if (Object.keys(toSave).length) {
      await query(
        `UPDATE contacts SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1`,
        [contact.id, JSON.stringify(toSave)]
      );
      // Já vale pros próximos passos do mesmo fluxo ({{Coluna}}).
      contact.custom_fields = { ...(contact.custom_fields || {}), ...toSave };
      broadcast({ type: 'contact:updated', contactId: contact.id, conversationId: conversation.id });
    }
    return 'found';
  } catch (err) {
    logger.error('automation_sheets_lookup_failed', { flowId: flow.id, message: err.message });
    return 'error';
  }
}

// Fluxo de destino de um "Conectar Automação": precisa existir, ser do mesmo
// tenant e estar ativo (pausar a automação de destino desliga o atalho).
async function getStartableFlow(flowId, fromFlow) {
  if (!flowId) return null;
  const result = await query(
    'SELECT * FROM automation_flows WHERE id = $1 AND tenant_id = $2',
    [flowId, fromFlow.tenant_id]
  );
  const target = result.rows[0];
  if (!target) {
    logger.info('automation_start_flow_target_missing', { flowId: fromFlow.id, targetFlowId: flowId });
    return null;
  }
  if (!target.is_active) {
    logger.info('automation_start_flow_target_paused', { flowId: fromFlow.id, targetFlowId: flowId });
    return null;
  }
  return target;
}

// Log leve de execução de nó, pra métricas do construtor. Nunca derruba o fluxo.
async function logStep(flowId, stepId, runId, conversationId, outcome) {
  try {
    await query(
      `INSERT INTO automation_step_logs (automation_flow_id, step_id, run_id, conversation_id, outcome) VALUES ($1,$2,$3,$4,$5)`,
      [flowId, stepId, runId, conversationId, outcome]
    );
  } catch (err) {
    logger.error('automation_step_log_failed', { stepId, message: err.message });
  }
}

async function evaluateCondition(config, { contact, conversation }) {
  const check = config?.check;
  if (check === 'tag_exists') {
    return (contact.tags || []).includes(config.tag);
  }
  if (check === 'stage_equals') {
    return conversation.funnel_stage_id === config.funnel_stage_id;
  }
  if (check === 'business_hours') {
    return isWithinBusinessHours(config.business_hours || {});
  }
  return false;
}

// Usado pelo nó "Condição" com critério "Horário comercial" — mesma lógica
// de fuso/dia da semana usada pelos Agentes de IA (src/automation/aiAgents.js).
function isWithinBusinessHours(config) {
  try {
    const tz = config.tz || 'America/Sao_Paulo';
    const now = new Date();
    const weekdayStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = weekdayMap[weekdayStr];
    const weekdays = config.weekdays && config.weekdays.length ? config.weekdays : [1, 2, 3, 4, 5];
    if (!weekdays.includes(weekday)) return false;

    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
    const hh = parts.find((p) => p.type === 'hour').value;
    const mm = parts.find((p) => p.type === 'minute').value;
    const nowMinutes = parseInt(hh, 10) * 60 + parseInt(mm, 10);

    const [startH, startM] = (config.start || '09:00').split(':').map(Number);
    const [endH, endM] = (config.end || '18:00').split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  } catch {
    return true;
  }
}

// Retorna true quando a mensagem foi tratada por um fluxo de automação
// (disparou um fluxo ou respondeu a uma pergunta pendente) — nesse caso os
// Agentes de IA ficam em silêncio, pra não responder junto com o fluxo.
export async function runTriggersForInboundMessage({ conversation, contact, message }) {
  // Contato "só humano": nenhum fluxo dispara nem continua (a mensagem só
  // aparece no Inbox). Retorna true pra os Agentes de IA também ficarem quietos.
  if (contact.bot_paused) return true;
  // Trigger: primeira mensagem da conversa dispara fluxos configurados como "first_message".
  // Se nenhum disparar, cai na checagem de palavra-chave abaixo — senão um
  // lead novo que chega mandando a palavra de uma campanha seria ignorado.
  if (await isFirstMessageOfConversation(conversation.id)) {
    const flows = await getActiveFlowsByTrigger('first_message', conversation.funnel_id);
    let handled = false;
    for (const flow of flows) {
      const firstStep = await getFirstStep(flow.id);
      if (!firstStep) continue;
      const run = await createRun(flow.id, conversation.id, firstStep.id, 'running');
      handled = true;
      await runFlowFromStep({ flow, conversation, contact, step: firstStep, run });
    }
    if (handled) return true;
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
    if (!matched) return false;

    const firstStep = await getFirstStep(matched.id);
    if (!firstStep) return false;
    const newRun = await createRun(matched.id, conversation.id, firstStep.id, 'running');
    await runFlowFromStep({ flow: matched, conversation, contact, step: firstStep, run: newRun });
    return true;
  }

  const step = await getStep(run.current_step_id);
  const flowResult = await query('SELECT * FROM automation_flows WHERE id = $1', [run.automation_flow_id]);
  const flow = flowResult.rows[0];

  let nextStepId = step?.next_step_id;
  if (step?.step_type === 'ask_question') {
    // Valida e grava a resposta na ficha; se for inválida, repergunta e
    // continua aguardando. Com "caminho por opção", segue o ramo da opção.
    const reply = await handleQuestionReply({ flow, run, step, conversation, contact, message });
    if (reply.outcome === 'retry') return true;
    nextStepId = reply.nextStepId;
  } else if (step) {
    await query(
      'INSERT INTO automation_run_answers (automation_run_id, step_id, answer) VALUES ($1,$2,$3)',
      [run.id, run.current_step_id, message.body]
    );
  }

  const nextStep = nextStepId ? await getStep(nextStepId) : null;

  if (!nextStep) {
    await updateRun(run.id, { currentStepId: null, status: 'completed' });
    return true;
  }

  await updateRun(run.id, { currentStepId: nextStep.id, status: 'running' });
  await runFlowFromStep({ flow, conversation, contact, step: nextStep, run });
  return true;
}

// Gatilho: tag adicionada a um contato (chamado pela rota de tags em api.js).
export async function runTriggersForTagAdded({ conversation, contact, tag }) {
  if (!conversation || contact?.bot_paused) return;
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
  if (contact?.bot_paused) return;
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
  if (contact?.bot_paused) {
    // Pausado durante a espera: encerra a run em vez de mandar a próxima mensagem.
    await updateRun(run.id, { currentStepId: null, status: 'stopped' });
    return;
  }

  const nextStep = await getStep(nextId);
  await updateRun(run.id, { currentStepId: nextStep.id, status: 'running' });
  await runFlowFromStep({ flow, conversation, contact, step: nextStep, run });
}
