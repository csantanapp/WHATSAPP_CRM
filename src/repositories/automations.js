import { query } from '../db/pool.js';
import { getDefaultTenantId } from '../tenant.js';

export async function listFlowsWithSteps(tenantId, funnelId) {
  const flows = funnelId
    ? await query(
        'SELECT * FROM automation_flows WHERE tenant_id = $1 AND (funnel_id = $2 OR funnel_id IS NULL) ORDER BY created_at DESC',
        [tenantId, funnelId]
      )
    : await query('SELECT * FROM automation_flows WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId]);

  const steps = await query(
    'SELECT afs.* FROM automation_flow_steps afs JOIN automation_flows af ON af.id = afs.automation_flow_id WHERE af.tenant_id = $1 ORDER BY afs.position ASC',
    [tenantId]
  );
  return flows.rows.map((flow) => ({
    ...flow,
    steps: steps.rows.filter((s) => s.automation_flow_id === flow.id),
  }));
}

export async function getFlowWithSteps(flowId) {
  const flowResult = await query('SELECT * FROM automation_flows WHERE id = $1', [flowId]);
  const flow = flowResult.rows[0];
  if (!flow) return null;
  const steps = await query(
    'SELECT * FROM automation_flow_steps WHERE automation_flow_id = $1 ORDER BY position ASC',
    [flowId]
  );
  return { ...flow, steps: steps.rows };
}

export async function createFlow({ name, funnelId, triggerType, triggerConfig = {}, isActive = true }) {
  const tenantId = await getDefaultTenantId();
  const result = await query(
    `INSERT INTO automation_flows (tenant_id, name, funnel_id, trigger_type, trigger_config, is_active)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [tenantId, name, funnelId || null, triggerType, JSON.stringify(triggerConfig), isActive]
  );
  return result.rows[0];
}

export async function updateFlow(flowId, { name, funnelId, triggerType, triggerConfig, triggerPositionX, triggerPositionY }) {
  const result = await query(
    `UPDATE automation_flows SET
       name = COALESCE($2, name),
       funnel_id = $3,
       trigger_type = COALESCE($4, trigger_type),
       trigger_config = COALESCE($5, trigger_config),
       trigger_position_x = COALESCE($6, trigger_position_x),
       trigger_position_y = COALESCE($7, trigger_position_y),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [flowId, name ?? null, funnelId ?? null, triggerType ?? null, triggerConfig ? JSON.stringify(triggerConfig) : null, triggerPositionX ?? null, triggerPositionY ?? null]
  );
  return result.rows[0];
}

export async function deleteFlow(flowId) {
  await query('DELETE FROM automation_flows WHERE id = $1', [flowId]);
}

// Salva o canvas inteiro de uma vez: cada passo chega com um client_id
// (gerado no navegador, só existe enquanto o fluxo não foi salvo) e referencia
// outros passos pelo client_id em next_step_id/next_step_id_true/next_step_id_false.
// Insere tudo primeiro (pra ganhar os ids reais do banco), monta o mapa
// client_id -> id real, e só então resolve os links num segundo passo —
// assim um passo pode apontar pra outro que ainda não existia (loop do nó
// "Repetir" apontando pra trás, por exemplo).
// steps[0] é sempre o passo ligado diretamente ao Gatilho (convenção do
// frontend), e vira position = 0, o que getFirstStep() usa pra achar a
// entrada do fluxo.
export async function replaceFlowSteps(flowId, steps) {
  // Nós que já existem chegam com client_id "s<id>" (o canvas monta assim ao
  // carregar) e são ATUALIZADOS no lugar, mantendo o id — assim as métricas
  // por nó e as runs paradas num nó (lead no meio de um formulário) não se
  // perdem a cada "Salvar". Nós novos são inseridos; os que sumiram do canvas
  // são removidos.
  const existing = await query('SELECT id FROM automation_flow_steps WHERE automation_flow_id = $1', [flowId]);
  const existingIds = new Set(existing.rows.map((r) => String(r.id)));

  if (!steps.length) {
    await query('DELETE FROM automation_flow_steps WHERE automation_flow_id = $1', [flowId]);
    return getFlowWithSteps(flowId);
  }

  // client_id é opcional: quando o chamador não manda (uso antigo, lista
  // simples sem links explícitos), cada passo ganha um client_id sintético
  // e é encadeado linearmente ao próximo — mesmo comportamento de antes.
  const normalized = steps.map((s, i) => ({ ...s, client_id: s.client_id || `__pos_${i}` }));
  const hasExplicitLinks = steps.some((s) => s.client_id);

  const idByClientId = {};
  const keptIds = [];
  for (let i = 0; i < normalized.length; i++) {
    const s = normalized[i];
    // option_next (ramo por opção do nó Pergunta) chega fora do config, com
    // client_ids — é resolvido pros ids reais no segundo passo, abaixo.
    const { option_next: _ignored, ...config } = s.config || {};
    const match = /^s(\d+)$/.exec(String(s.client_id));
    if (match && existingIds.has(match[1])) {
      await query(
        `UPDATE automation_flow_steps SET step_type = $2, config = $3, position = $4, position_x = $5, position_y = $6
         WHERE id = $1`,
        [match[1], s.step_type, JSON.stringify(config), i, s.position_x || 0, s.position_y || 0]
      );
      idByClientId[s.client_id] = match[1];
      keptIds.push(match[1]);
      continue;
    }
    const inserted = await query(
      `INSERT INTO automation_flow_steps (automation_flow_id, step_type, config, position, position_x, position_y)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [flowId, s.step_type, JSON.stringify(config), i, s.position_x || 0, s.position_y || 0]
    );
    idByClientId[s.client_id] = inserted.rows[0].id;
    keptIds.push(String(inserted.rows[0].id));
  }

  // Remove os nós que saíram do canvas (antes de religar, pra não apontar pra eles).
  await query(
    'DELETE FROM automation_flow_steps WHERE automation_flow_id = $1 AND NOT (id::text = ANY($2::text[]))',
    [flowId, keptIds]
  );

  for (let i = 0; i < normalized.length; i++) {
    const s = normalized[i];
    const realId = idByClientId[s.client_id];

    let nextRef = s.next_step_id;
    if (nextRef === undefined && !hasExplicitLinks) {
      // Modo legado: encadeia com o próximo item da lista, exceto o último.
      nextRef = i < normalized.length - 1 ? normalized[i + 1].client_id : null;
    }

    const nextStepId = nextRef ? idByClientId[nextRef] || null : null;
    const nextStepIdTrue = s.next_step_id_true ? idByClientId[s.next_step_id_true] || null : null;
    const nextStepIdFalse = s.next_step_id_false ? idByClientId[s.next_step_id_false] || null : null;
    await query(
      `UPDATE automation_flow_steps SET next_step_id = $2, next_step_id_true = $3, next_step_id_false = $4 WHERE id = $1`,
      [realId, nextStepId, nextStepIdTrue, nextStepIdFalse]
    );

    // Nó Pergunta com "caminho por opção": { "<índice da opção>": client_id }
    // vira config.option_next = { "<índice>": id real do passo }.
    if (s.option_next && typeof s.option_next === 'object') {
      const optionNext = {};
      for (const [index, ref] of Object.entries(s.option_next)) {
        if (ref && idByClientId[ref]) optionNext[index] = idByClientId[ref];
      }
      await query(
        `UPDATE automation_flow_steps SET config = config || jsonb_build_object('option_next', $2::jsonb) WHERE id = $1`,
        [realId, JSON.stringify(optionNext)]
      );
    }
  }

  return getFlowWithSteps(flowId);
}

export async function addStep(flowId, { stepType, config = {}, position }) {
  const result = await query(
    `INSERT INTO automation_flow_steps (automation_flow_id, step_type, config, position)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [flowId, stepType, JSON.stringify(config), position]
  );
  return result.rows[0];
}

export async function linkSteps(stepId, nextStepId) {
  await query('UPDATE automation_flow_steps SET next_step_id = $2 WHERE id = $1', [stepId, nextStepId]);
}

export async function setFlowActive(flowId, isActive) {
  const result = await query(
    'UPDATE automation_flows SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [flowId, isActive]
  );
  return result.rows[0];
}

// Métricas do fluxo pro construtor (estilo ManyChat). `days` = janela
// (7/30/...); null = desde sempre. Taxas de entrega/leitura só contam
// mensagens de WhatsApp — o Instagram não manda status de entrega.
export async function getFlowMetrics(flowId, days = null) {
  const since = days ? new Date(Date.now() - days * 86400 * 1000) : new Date(0);

  const summary = await query(
    `SELECT count(*)::int AS runs,
            count(DISTINCT c.contact_id)::int AS contacts,
            count(*) FILTER (WHERE r.status = 'completed')::int AS completed,
            count(*) FILTER (WHERE r.status IN ('waiting_reply','waiting_delay','running'))::int AS in_progress
     FROM automation_runs r JOIN conversations c ON c.id = r.conversation_id
     WHERE r.automation_flow_id = $1 AND r.started_at >= $2`,
    [flowId, since]
  );

  const captured = await query(
    `SELECT s.config->>'save_to' AS save_to, count(DISTINCT a.automation_run_id)::int AS total
     FROM automation_run_answers a
     JOIN automation_runs r ON r.id = a.automation_run_id
     JOIN automation_flow_steps s ON s.id = a.step_id
     WHERE r.automation_flow_id = $1 AND a.is_valid AND a.created_at >= $2
       AND coalesce(s.config->>'save_to', '') <> ''
     GROUP BY 1`,
    [flowId, since]
  );

  const logs = await query(
    `SELECT step_id::text AS step_id, count(*)::int AS executions,
            count(*) FILTER (WHERE outcome = 'true')::int AS branch_true,
            count(*) FILTER (WHERE outcome = 'false')::int AS branch_false,
            count(*) FILTER (WHERE outcome = 'skipped_known')::int AS skipped_known
     FROM automation_step_logs WHERE automation_flow_id = $1 AND created_at >= $2
     GROUP BY step_id`,
    [flowId, since]
  );

  const delivery = await query(
    `SELECT m.automation_step_id::text AS step_id,
            count(*)::int AS wa_messages,
            count(*) FILTER (WHERE m.status IN ('delivered','read'))::int AS delivered,
            count(*) FILTER (WHERE m.status = 'read')::int AS read,
            count(*) FILTER (WHERE m.status = 'failed')::int AS failed
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     JOIN contacts ct ON ct.id = c.contact_id
     WHERE m.automation_flow_id = $1 AND m.automation_step_id IS NOT NULL AND m.created_at >= $2
       AND coalesce(ct.channel, 'whatsapp') = 'whatsapp'
     GROUP BY m.automation_step_id`,
    [flowId, since]
  );

  const answers = await query(
    `SELECT a.step_id::text AS step_id,
            count(DISTINCT a.automation_run_id) FILTER (WHERE a.is_valid)::int AS answered,
            count(*) FILTER (WHERE NOT a.is_valid)::int AS invalid
     FROM automation_run_answers a JOIN automation_runs r ON r.id = a.automation_run_id
     WHERE r.automation_flow_id = $1 AND a.created_at >= $2
     GROUP BY a.step_id`,
    [flowId, since]
  );
  const options = await query(
    `SELECT a.step_id::text AS step_id, a.option_index, count(DISTINCT a.automation_run_id)::int AS total
     FROM automation_run_answers a JOIN automation_runs r ON r.id = a.automation_run_id
     WHERE r.automation_flow_id = $1 AND a.created_at >= $2 AND a.is_valid AND a.option_index IS NOT NULL
     GROUP BY a.step_id, a.option_index`,
    [flowId, since]
  );

  const steps = {};
  const stepOf = (id) => (steps[id] = steps[id] || { executions: 0, options: {} });
  logs.rows.forEach((r) => Object.assign(stepOf(r.step_id), {
    executions: r.executions, branch_true: r.branch_true, branch_false: r.branch_false, skipped_known: r.skipped_known,
  }));
  delivery.rows.forEach((r) => Object.assign(stepOf(r.step_id), {
    wa_messages: r.wa_messages, delivered: r.delivered, read: r.read, failed: r.failed,
  }));
  answers.rows.forEach((r) => Object.assign(stepOf(r.step_id), { answered: r.answered, invalid: r.invalid }));
  options.rows.forEach((r) => { stepOf(r.step_id).options[r.option_index] = r.total; });

  return {
    days,
    summary: {
      ...summary.rows[0],
      captured: Object.fromEntries(captured.rows.map((r) => [r.save_to, r.total])),
    },
    steps,
  };
}
