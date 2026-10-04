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
