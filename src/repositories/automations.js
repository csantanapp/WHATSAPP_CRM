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
  await query('DELETE FROM automation_flow_steps WHERE automation_flow_id = $1', [flowId]);
  if (!steps.length) return getFlowWithSteps(flowId);

  // client_id é opcional: quando o chamador não manda (uso antigo, lista
  // simples sem links explícitos), cada passo ganha um client_id sintético
  // e é encadeado linearmente ao próximo — mesmo comportamento de antes.
  const normalized = steps.map((s, i) => ({ ...s, client_id: s.client_id || `__pos_${i}` }));
  const hasExplicitLinks = steps.some((s) => s.client_id);

  const idByClientId = {};
  for (let i = 0; i < normalized.length; i++) {
    const s = normalized[i];
    const inserted = await query(
      `INSERT INTO automation_flow_steps (automation_flow_id, step_type, config, position, position_x, position_y)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [flowId, s.step_type, JSON.stringify(s.config || {}), i, s.position_x || 0, s.position_y || 0]
    );
    idByClientId[s.client_id] = inserted.rows[0].id;
  }

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
