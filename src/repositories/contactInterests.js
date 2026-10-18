import { query } from '../db/pool.js';
import { getDefaultTenantId } from '../tenant.js';
import { logActivity } from './activityLog.js';

// Histórico de produtos de interesse do lead. Não duplica: se o registro mais
// recente do contato já é o mesmo produto (sem diferenciar maiúsculas) nas
// últimas 24h, devolve ele em vez de criar outro — o mesmo formulário
// respondido duas vezes, ou formulário + oportunidade no mesmo dia, vira 1 linha.

const SOURCE_LABEL = { manual: 'manual', form: 'formulário', opportunity: 'oportunidade' };

export async function addInterest({ contactId, product, source = 'manual', sourceLabel = null, conversationId = null, userId = null }) {
  const clean = String(product || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!clean) return null;
  const tenantId = await getDefaultTenantId();

  const last = await query(
    `SELECT * FROM contact_interests WHERE contact_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [contactId]
  );
  const prev = last.rows[0];
  if (prev && prev.product.toLowerCase() === clean.toLowerCase() && Date.now() - new Date(prev.created_at).getTime() < 24 * 3600 * 1000) {
    return prev;
  }

  const result = await query(
    `INSERT INTO contact_interests (tenant_id, contact_id, product, source, source_label, conversation_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tenantId, contactId, clean, source, sourceLabel, conversationId, userId]
  );
  await logActivity({
    contactId, conversationId,
    type: 'interest',
    description: `Interesse em "${clean}" (${SOURCE_LABEL[source] || source}${sourceLabel ? ': ' + sourceLabel : ''})`,
  });
  return result.rows[0];
}

export async function listInterests(tenantId, contactId) {
  const result = await query(
    `SELECT ci.*, u.name AS created_by_name
     FROM contact_interests ci
     LEFT JOIN users u ON u.id = ci.created_by
     WHERE ci.tenant_id = $1 AND ci.contact_id = $2
     ORDER BY ci.created_at DESC, ci.id DESC`,
    [tenantId, contactId]
  );
  return result.rows;
}

export async function deleteInterest(tenantId, id) {
  const result = await query('DELETE FROM contact_interests WHERE tenant_id = $1 AND id = $2 RETURNING id', [tenantId, id]);
  return result.rows[0];
}

// Produtos já registrados (sugestões ao digitar e filtro da lista de Contatos).
export async function listInterestProducts(tenantId) {
  const result = await query(
    `SELECT min(product) AS product, count(DISTINCT contact_id)::int AS contacts
     FROM contact_interests WHERE tenant_id = $1
     GROUP BY lower(product) ORDER BY contacts DESC, 1 ASC`,
    [tenantId]
  );
  return result.rows;
}
