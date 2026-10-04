import { query } from '../db/pool.js';
import { createTag } from './tags.js';
import { logActivity } from './activityLog.js';

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

  const inserted = await query(
    `INSERT INTO contacts (wa_id, name, phone_display, avatar_initials)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [waId, name || null, phoneDisplay || waId, initialsOf(name, waId)]
  );
  return inserted.rows[0];
}

export async function createContact({ waId, name, phoneDisplay, source, email }) {
  const inserted = await query(
    `INSERT INTO contacts (wa_id, name, phone_display, avatar_initials, source, email)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [waId, name || null, phoneDisplay || waId, initialsOf(name, waId), source || null, email || null]
  );
  return inserted.rows[0];
}

// Só atualiza os campos explicitamente passados (undefined = "não mexer");
// string vazia é um valor válido e limpa o campo.
export async function updateContact(id, fields) {
  const columns = ['name', 'email', 'source', 'notes'].filter((key) => fields[key] !== undefined);
  if (!columns.length) return getContactById(id);

  const setClause = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
  const values = columns.map((col) => fields[col] || null);
  const result = await query(
    `UPDATE contacts SET ${setClause}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
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

export async function listContacts(searchTerm, funnelId) {
  const conditions = [];
  const params = [];

  if (searchTerm) {
    params.push(`%${searchTerm}%`);
    conditions.push(`(c.name ILIKE $${params.length} OR c.phone_display ILIKE $${params.length} OR c.wa_id ILIKE $${params.length} OR c.email ILIKE $${params.length})`);
  }
  if (funnelId) {
    params.push(funnelId);
    conditions.push(`EXISTS (SELECT 1 FROM conversations conv WHERE conv.contact_id = c.id AND conv.funnel_id = $${params.length})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await query(`SELECT c.* FROM contacts c ${where} ORDER BY c.created_at DESC`, params);
  return result.rows;
}

export async function getContactById(id) {
  const result = await query('SELECT * FROM contacts WHERE id = $1', [id]);
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
  return result.rows[0] || (await getContactById(contactId));
}
