import { query } from '../db/pool.js';
import { deleteMediaFiles } from '../services/mediaStorage.js';
import { logger } from '../logger.js';
import { createTag } from './tags.js';
import { logActivity } from './activityLog.js';
import { getDefaultTenantId } from '../tenant.js';

function initialsOf(name, fallback) {
  return (
    (name || fallback || '')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '?'
  );
}

export async function findOrCreateContactByWaId(waId, { name, phoneDisplay } = {}) {
  const existing = await query('SELECT * FROM contacts WHERE wa_id = $1', [waId]);
  if (existing.rows[0]) return existing.rows[0];

  const tenantId = await getDefaultTenantId();
  const inserted = await query(
    `INSERT INTO contacts (tenant_id, wa_id, name, phone_display, avatar_initials)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [tenantId, waId, name || null, phoneDisplay || waId, initialsOf(name, waId)]
  );
  return inserted.rows[0];
}

// Cadastro manual (atendente): nome/e-mail informados já contam como confirmados.
export async function createContact({ waId, name, phoneDisplay, source, email }) {
  const tenantId = await getDefaultTenantId();
  const confirmed = [name && 'name', email && 'email'].filter(Boolean);
  const inserted = await query(
    `INSERT INTO contacts (tenant_id, wa_id, name, phone_display, avatar_initials, source, email, confirmed_fields)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tenantId, waId, name || null, phoneDisplay || waId, initialsOf(name, waId), source || null, email || null, confirmed]
  );
  return inserted.rows[0];
}

// Marca (ou desmarca) nome/e-mail como confirmado por uma pessoa — ver
// migration 013_campos_confirmados.sql.
export async function setFieldConfirmed(contactId, field, confirmed) {
  await query(
    confirmed
      ? 'UPDATE contacts SET confirmed_fields = array_append(array_remove(confirmed_fields, $2), $2) WHERE id = $1'
      : 'UPDATE contacts SET confirmed_fields = array_remove(confirmed_fields, $2) WHERE id = $1',
    [contactId, field]
  );
}

// Só atualiza os campos explicitamente passados (undefined = "não mexer");
// string vazia é um valor válido e limpa o campo.
export async function updateContact(id, fields) {
  if (fields.bot_paused !== undefined) {
    const paused = Boolean(fields.bot_paused);
    const changed = await query(
      'UPDATE contacts SET bot_paused = $2, updated_at = now() WHERE id = $1 AND bot_paused <> $2 RETURNING id',
      [id, paused]
    );
    if (changed.rowCount) {
      await logActivity({
        contactId: id,
        type: paused ? 'bot_paused' : 'bot_resumed',
        description: paused ? 'Atendimento só humano: IA e automações pausadas para este contato' : 'IA e automações reativadas para este contato',
      });
    }
  }

  const columns = ['name', 'email', 'source', 'notes'].filter((key) => fields[key] !== undefined);
  if (!columns.length) {
    const current = await query('SELECT * FROM contacts WHERE id = $1', [id]);
    return current.rows[0];
  }

  const setClause = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
  const values = columns.map((col) => fields[col] || null);
  await query(`UPDATE contacts SET ${setClause}, updated_at = now() WHERE id = $1`, [id, ...values]);

  // Nome/e-mail editados por atendente passam a valer como confirmados
  // (apagar o campo desfaz a confirmação).
  for (const field of ['name', 'email']) {
    if (fields[field] !== undefined) await setFieldConfirmed(id, field, Boolean(fields[field]));
  }
  const result = await query('SELECT * FROM contacts WHERE id = $1', [id]);
  return result.rows[0];
}

export async function removeTagFromContact(contactId, tag) {
  const result = await query(
    `UPDATE contacts SET tags = array_remove(tags, $2), updated_at = now() WHERE id = $1 RETURNING *`,
    [contactId, tag]
  );
  await logActivity({ contactId, type: 'tag_removed', description: `Tag removida: "${tag}"` });
  return result.rows[0];
}

export async function listContacts(tenantId, searchTerm, funnelId) {
  const conditions = ['c.tenant_id = $1'];
  const params = [tenantId];

  if (searchTerm) {
    params.push(`%${searchTerm}%`);
    conditions.push(`(c.name ILIKE $${params.length} OR c.phone_display ILIKE $${params.length} OR c.wa_id ILIKE $${params.length} OR c.email ILIKE $${params.length})`);
  }
  if (funnelId) {
    params.push(funnelId);
    conditions.push(`EXISTS (SELECT 1 FROM conversations conv WHERE conv.contact_id = c.id AND conv.funnel_id = $${params.length})`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  // interests: produtos distintos do histórico; latest_interest: o mais recente.
  const result = await query(
    `SELECT c.*,
            (SELECT array_agg(DISTINCT ci.product) FROM contact_interests ci WHERE ci.contact_id = c.id) AS interests,
            (SELECT ci.product FROM contact_interests ci WHERE ci.contact_id = c.id ORDER BY ci.created_at DESC, ci.id DESC LIMIT 1) AS latest_interest
     FROM contacts c ${where} ORDER BY c.created_at DESC`,
    params
  );
  return result.rows;
}

export async function getContactById(tenantId, id) {
  const result = await query('SELECT * FROM contacts WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  return result.rows[0];
}

// Exclui o contato (conversas e mensagens vão junto, em cascata) e apaga do
// disco as mídias dessas mensagens.
export async function deleteContact(tenantId, id) {
  const media = await query(
    `SELECT m.media_url FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.contact_id = $1 AND c.tenant_id = $2 AND m.media_url IS NOT NULL`,
    [id, tenantId]
  );
  const result = await query('DELETE FROM contacts WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId]);
  if (result.rows[0] && media.rows.length) {
    try {
      await deleteMediaFiles(media.rows.map((r) => r.media_url));
    } catch (err) {
      logger.error('contact_media_delete_failed', { contactId: id, message: err.message });
    }
  }
  return result.rows[0];
}

export async function getContactConversations(contactId) {
  const result = await query(
    `SELECT c.*, f.name AS funnel_name, fs.name AS stage_name
     FROM conversations c
     LEFT JOIN funnels f ON f.id = c.funnel_id
     LEFT JOIN funnel_stages fs ON fs.id = c.funnel_stage_id
     WHERE c.contact_id = $1 ORDER BY c.created_at DESC`,
    [contactId]
  );
  return result.rows;
}

export async function addTagToContact(contactId, tag) {
  await createTag(tag); // garante que a tag entra no catálogo (tela de Funis), mesmo se criada aqui
  const result = await query(
    `UPDATE contacts SET tags = array_append(tags, $2), updated_at = now()
     WHERE id = $1 AND NOT ($2 = ANY(tags)) RETURNING *`,
    [contactId, tag]
  );
  if (result.rows[0]) {
    await logActivity({ contactId, type: 'tag_added', description: `Tag adicionada: "${tag}"` });
  }
  return result.rows[0] || (await getContactById(await getDefaultTenantId(), contactId));
}

export async function findOrCreateContactByIgUserId(igUserId, { name } = {}) {
  const existing = await query('SELECT * FROM contacts WHERE ig_user_id = $1', [igUserId]);
  if (existing.rows[0]) return existing.rows[0];

  const tenantId = await getDefaultTenantId();
  const display = name || ('Instagram ' + igUserId.slice(-6));
  const inserted = await query(
    `INSERT INTO contacts (tenant_id, ig_user_id, channel, name, phone_display, avatar_initials)
     VALUES ($1, $2, 'instagram', $3, $4, $5) RETURNING *`,
    [tenantId, igUserId, name || null, display, initialsOf(name, igUserId)]
  );
  return inserted.rows[0];
}
