import { query } from '../db/pool.js';

export async function listFlowsWithSteps(funnelId) {
  const flows = funnelId
    ? await query(
        'SELECT * FROM automation_flows WHERE funnel_id = $1 OR funnel_id IS NULL ORDER BY created_at DESC',
        [funnelId]
      )
    : await query('SELECT * FROM automation_flows ORDER BY created_at DESC');

  const steps = await query('SELECT * FROM automation_flow_steps ORDER BY position ASC');
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
  const result = await query(
    `INSERT INTO automation_flows (name, funnel_id, trigger_type, trigger_config, is_active)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, funnelId || null, triggerType, JSON.stringify(triggerConfig), isActive]
  );
  return result.rows[0];
}

export async function updateFlow(flowId, { name, funnelId, triggerType, triggerConfig }) {
  const result = await query(
    `UPDATE automation_flows SET
       name = COALESCE($2, name),
       funnel_id = $3,
       trigger_type = COALESCE($4, trigger_type),
       trigger_config = COALESCE($5, trigger_config),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [flowId, name ?? null, funnelId ?? null, triggerType ?? null, triggerConfig ? JSON.stringify(triggerConfig) : null]
  );
  return result.rows[0];
}

export async function deleteFlow(flowId) {
  await query('DELETE FROM automation_flows WHERE id = $1', [flowId]);
}

export async function replaceFlowSteps(flowId, steps) {
  await query('DELETE FROM automation_flow_steps WHERE automation_flow_id = $1', [flowId]);
  let previousStepId = null;
  for (let i = 0; i < steps.length; i++) {
    const step = await addStep(flowId, { stepType: steps[i].step_type, config: steps[i].config, position: i });
    if (previousStepId) await linkSteps(previousStepId, step.id);
    previousStepId = step.id;
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
