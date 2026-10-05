import { query } from '../db/pool.js';

// Dados crus pro radar diário — tudo calculado no SQL, a IA só organiza em
// prioridades (ver AIService.generateDailyRadar).
export async function getRadarData(tenantId) {
  const [semResposta, oportunidadesParadas, tarefasVencidas, maioresOportunidades] = await Promise.all([
    query(
      `SELECT c.id, ct.name AS contact_name, c.last_inbound_at
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.tenant_id = $1 AND c.status != 'closed'
         AND c.last_inbound_at IS NOT NULL
         AND (c.last_message_at IS NULL OR c.last_inbound_at >= c.last_message_at - interval '1 second')
         AND c.last_inbound_at < now() - interval '2 hours'
       ORDER BY c.last_inbound_at ASC LIMIT 10`,
      [tenantId]
    ),
    query(
      `SELECT o.id, o.title, o.value, ct.name AS contact_name, o.updated_at
       FROM opportunities o JOIN contacts ct ON ct.id = o.contact_id
       WHERE o.tenant_id = $1 AND o.status = 'open' AND o.updated_at < now() - interval '3 days'
       ORDER BY o.value DESC NULLS LAST LIMIT 10`,
      [tenantId]
    ),
    query(
      `SELECT t.id, t.title, t.due_at, ct.name AS contact_name
       FROM tasks t LEFT JOIN contacts ct ON ct.id = t.contact_id
       WHERE t.tenant_id = $1 AND t.status = 'pending' AND t.due_at < now()
       ORDER BY t.due_at ASC LIMIT 10`,
      [tenantId]
    ),
    query(
      `SELECT o.id, o.title, o.value, ct.name AS contact_name
       FROM opportunities o JOIN contacts ct ON ct.id = o.contact_id
       WHERE o.tenant_id = $1 AND o.status = 'open'
       ORDER BY o.value DESC NULLS LAST LIMIT 5`,
      [tenantId]
    ),
  ]);

  return {
    conversas_sem_resposta: semResposta.rows,
    oportunidades_paradas: oportunidadesParadas.rows,
    tarefas_vencidas: tarefasVencidas.rows,
    maiores_oportunidades_abertas: maioresOportunidades.rows,
  };
}

// Radar de risco: demandas (conversas abertas) sem "proximo passo" marcado.
// Proximo passo = tarefa pendente com due_at futuro vinculada a conversa
// (mesmo mecanismo do botao "Lembrar"). Sem isso, categoriza por tempo parado:
// >=24h sem responder/avancar = critico, abaixo disso = em risco.
// "Em voo" = ja tem um proximo passo agendado, nao e mais risco.
export async function getRiskRadarConversations(tenantId, viewer) {
  const conditions = ['c.tenant_id = $1', "c.status != 'closed'"];
  const params = [tenantId];

  if (viewer && viewer.role === 'atendente' && !viewer.isPlatformAdmin) {
    params.push(viewer.id);
    conditions.push(`(c.assigned_user_id = $${params.length} OR c.assigned_user_id IS NULL)`);
  }

  const result = await query(
    `SELECT c.id, c.assigned_user_id, u.name AS assigned_user_name,
            c.last_message_at, c.created_at,
            ct.name AS contact_name, ct.phone_display,
            EXISTS (
              SELECT 1 FROM tasks t
              WHERE t.conversation_id = c.id AND t.status = 'pending' AND t.due_at > now()
            ) AS has_next_step,
            EXTRACT(EPOCH FROM (now() - COALESCE(c.last_message_at, c.created_at))) / 3600 AS hours_stalled
     FROM conversations c
     JOIN contacts ct ON ct.id = c.contact_id
     LEFT JOIN users u ON u.id = c.assigned_user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY hours_stalled DESC
     LIMIT 500`,
    params
  );

  const items = result.rows
    .filter((r) => Number(r.hours_stalled) >= 1)
    .map((r) => {
      const hoursStalled = Number(r.hours_stalled);
      let category;
      if (r.has_next_step) category = 'em_voo';
      else if (hoursStalled >= 24) category = 'critico';
      else category = 'em_risco';
      return Object.assign({}, r, { hours_stalled: hoursStalled, category });
    });

  const counts = { critico: 0, em_risco: 0, em_voo: 0 };
  items.forEach((i) => { counts[i.category] += 1; });

  return { items, counts };
}
