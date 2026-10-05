import { query } from '../db/pool.js';

export async function listAgents(tenantId) {
  const result = await query(
    `SELECT a.*,
            f.name AS funnel_name,
            (SELECT count(*)::int FROM ai_agent_runs r WHERE r.ai_agent_id = a.id AND r.created_at >= date_trunc('day', now())) AS runs_today,
            (SELECT max(r.created_at) FROM ai_agent_runs r WHERE r.ai_agent_id = a.id) AS last_run_at
     FROM ai_agents a
     LEFT JOIN funnels f ON f.id = a.funnel_id
     WHERE a.tenant_id = $1
     ORDER BY a.created_at DESC`,
    [tenantId]
  );
  return result.rows;
}

export async function getAgent(tenantId, id) {
  const result = await query('SELECT * FROM ai_agents WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  return result.rows[0];
}

export async function createAgent(tenantId, fields) {
  const result = await query(
    `INSERT INTO ai_agents (
       tenant_id, name, description, system_prompt, provider, funnel_id, priority,
       keyword_regex, business_hours_enabled, business_hours_tz, business_hours_start, business_hours_end,
       allow_handoff, handoff_keywords
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
      tenantId, fields.name, fields.description || null, fields.system_prompt || '', fields.provider || null,
      fields.funnel_id || null, fields.priority || 0, fields.keyword_regex || null,
      !!fields.business_hours_enabled, fields.business_hours_tz || 'America/Sao_Paulo',
      fields.business_hours_start || '09:00', fields.business_hours_end || '18:00',
      fields.allow_handoff !== false, fields.handoff_keywords || [],
    ]
  );
  return result.rows[0];
}

export async function updateAgent(tenantId, id, fields) {
  const columns = [
    'name', 'description', 'system_prompt', 'provider', 'funnel_id', 'priority', 'keyword_regex',
    'business_hours_enabled', 'business_hours_tz', 'business_hours_start', 'business_hours_end',
    'allow_handoff', 'handoff_keywords',
  ].filter((key) => fields[key] !== undefined);
  if (!columns.length) return getAgent(tenantId, id);

  const setClause = columns.map((col, i) => `${col} = $${i + 3}`).join(', ');
  const values = columns.map((col) => fields[col]);
  const result = await query(
    `UPDATE ai_agents SET ${setClause}, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, tenantId, ...values]
  );
  return result.rows[0];
}

export async function setAgentActive(tenantId, id, isActive) {
  const result = await query(
    'UPDATE ai_agents SET is_active = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *',
    [id, tenantId, isActive]
  );
  return result.rows[0];
}

export async function deleteAgent(tenantId, id) {
  const result = await query('DELETE FROM ai_agents WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId]);
  return result.rows[0];
}

export async function duplicateAgent(tenantId, id) {
  const original = await getAgent(tenantId, id);
  if (!original) return null;
  return createAgent(tenantId, {
    name: original.name + ' (cópia)',
    description: original.description,
    system_prompt: original.system_prompt,
    provider: original.provider,
    funnel_id: original.funnel_id,
    priority: original.priority,
    keyword_regex: original.keyword_regex,
    business_hours_enabled: original.business_hours_enabled,
    business_hours_tz: original.business_hours_tz,
    business_hours_start: original.business_hours_start,
    business_hours_end: original.business_hours_end,
    allow_handoff: original.allow_handoff,
    handoff_keywords: original.handoff_keywords,
  });
}

// Candidatos ativos pra uma conversa, já ordenados por prioridade — o
// dispatcher (src/automation/aiAgents.js) escolhe o primeiro que casar com
// o gatilho (palavra-chave/horário).
export async function listActiveAgentsForDispatch(tenantId, funnelId) {
  const result = await query(
    `SELECT * FROM ai_agents
     WHERE tenant_id = $1 AND is_active = true AND (funnel_id IS NULL OR funnel_id = $2)
     ORDER BY priority DESC, created_at ASC`,
    [tenantId, funnelId || null]
  );
  return result.rows;
}

export async function logAgentRun(tenantId, agentId, conversationId, outcome) {
  await query(
    `INSERT INTO ai_agent_runs (tenant_id, ai_agent_id, conversation_id, outcome) VALUES ($1,$2,$3,$4)`,
    [tenantId, agentId, conversationId, outcome]
  );
}
