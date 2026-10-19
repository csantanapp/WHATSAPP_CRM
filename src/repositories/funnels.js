import { query } from '../db/pool.js';
import { createTag } from './tags.js';
import { getDefaultTenantId } from '../tenant.js';

export async function listFunnelsWithStages(tenantId) {
  const funnels = await query('SELECT * FROM funnels WHERE tenant_id = $1 ORDER BY position ASC', [tenantId]);
  const stages = await query(
    'SELECT fs.* FROM funnel_stages fs JOIN funnels f ON f.id = fs.funnel_id WHERE f.tenant_id = $1 ORDER BY fs.position ASC',
    [tenantId]
  );
  return funnels.rows.map((f) => ({
    ...f,
    stages: stages.rows.filter((s) => s.funnel_id === f.id),
  }));
}


// Etapas padrão de qualquer funil novo — mesmo conjunto do "Funil de Vendas" original.
// O usuário pode renomear, remover ou adicionar outras depois pela tela de Configurações.
const DEFAULT_STAGES = [
  { name: 'Novo lead', color: '#12A37D' },
  { name: 'Em atendimento', color: '#2563EB' },
  { name: 'Aguardando cliente', color: '#D97706' },
  { name: 'Fechado', color: '#7C3AED', is_closed_stage: true },
];

export async function createFunnel({ name, color = '#12A37D', welcomeMessage, stages, defaultTags }) {
  const tenantId = await getDefaultTenantId();
  const positionResult = await query('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM funnels WHERE tenant_id = $1', [tenantId]);
  const position = positionResult.rows[0].next;

  // Texto do link wa.me = o nome do funil ("Evento SP"); se já existir, "Evento SP 2".
  const entryKeyword = await uniqueEntryKeyword(tenantId, normalizeEntryKeyword(name) || 'campanha');

  const tags = defaultTags && defaultTags.length ? defaultTags : [];
  for (const tag of tags) await createTag(tag); // garante que entram no catálogo

  const result = await query(
    `INSERT INTO funnels (tenant_id, name, color, position, is_default, entry_keyword, welcome_message, default_tags)
     VALUES ($1,$2,$3,$4,false,$5,$6,$7) RETURNING *`,
    [tenantId, name, color, position, entryKeyword, welcomeMessage || null, tags]
  );
  const funnel = result.rows[0];

  const stagesToCreate = stages && stages.length ? stages : DEFAULT_STAGES;
  const createdStages = [];
  for (const s of stagesToCreate) {
    createdStages.push(await createStage(funnel.id, s));
  }

  return { ...funnel, stages: createdStages };
}

// Texto do link: espaços normalizados, até 60 caracteres.
export function normalizeEntryKeyword(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// Algum funil (fora `exceptFunnelId`) já usa esse texto, como atual ou apelido?
async function entryKeywordTaken(tenantId, keyword, exceptFunnelId = null) {
  const result = await query(
    `SELECT 1 FROM funnels f
     WHERE f.tenant_id = $1 AND ($3::bigint IS NULL OR f.id <> $3)
       AND (lower(f.entry_keyword) = lower($2) OR lower($2) = ANY (SELECT lower(a) FROM unnest(f.entry_keyword_aliases) a))
     LIMIT 1`,
    [tenantId, keyword, exceptFunnelId]
  );
  return result.rowCount > 0;
}

async function uniqueEntryKeyword(tenantId, base) {
  let candidate = base;
  for (let n = 2; await entryKeywordTaken(tenantId, candidate); n++) candidate = `${base} ${n}`;
  return candidate;
}

// Troca o texto do link. O texto anterior vira apelido (links antigos seguem
// funcionando). Lança erro com `status` 400/409 pra rota devolver a mensagem.
export async function updateFunnelEntryKeyword(funnelId, rawKeyword) {
  const tenantId = await getDefaultTenantId();
  const keyword = normalizeEntryKeyword(rawKeyword);
  if (keyword.replace(/[^\p{L}\p{N}]/gu, '').length < 3) {
    const err = new Error('O texto do link precisa ter pelo menos 3 letras ou números.');
    err.status = 400;
    throw err;
  }
  if (await entryKeywordTaken(tenantId, keyword, funnelId)) {
    const err = new Error(`Outro funil já usa “${keyword}” no link. Escolha um texto diferente.`);
    err.status = 409;
    throw err;
  }
  const current = (await query('SELECT entry_keyword, entry_keyword_aliases FROM funnels WHERE id = $1', [funnelId])).rows[0];
  if (!current) return null;
  let aliases = (current.entry_keyword_aliases || []).filter((a) => a.toLowerCase() !== keyword.toLowerCase());
  if (current.entry_keyword && current.entry_keyword.toLowerCase() !== keyword.toLowerCase() && !aliases.some((a) => a.toLowerCase() === current.entry_keyword.toLowerCase())) {
    aliases = [...aliases, current.entry_keyword];
  }
  const result = await query(
    'UPDATE funnels SET entry_keyword = $2, entry_keyword_aliases = $3 WHERE id = $1 RETURNING *',
    [funnelId, keyword, aliases]
  );
  return result.rows[0];
}

export async function updateFunnelEntry(funnelId, { welcomeMessage }) {
  const result = await query(
    'UPDATE funnels SET welcome_message = $2 WHERE id = $1 RETURNING *',
    [funnelId, welcomeMessage ?? null]
  );
  return result.rows[0];
}

export async function addDefaultTagToFunnel(funnelId, tag) {
  await createTag(tag); // garante que entra no catálogo
  const result = await query(
    `UPDATE funnels SET default_tags = array_append(default_tags, $2)
     WHERE id = $1 AND NOT ($2 = ANY(default_tags)) RETURNING *`,
    [funnelId, tag]
  );
  return result.rows[0] || (await query('SELECT * FROM funnels WHERE id = $1', [funnelId])).rows[0];
}

export async function removeDefaultTagFromFunnel(funnelId, tag) {
  const result = await query(
    `UPDATE funnels SET default_tags = array_remove(default_tags, $2) WHERE id = $1 RETURNING *`,
    [funnelId, tag]
  );
  return result.rows[0];
}

// Aplica as tags padrão do funil ao contato — chamado sempre que um lead entra
// (de verdade, ou é redirecionado) num funil, pra que a classificação seja automática.
export async function applyFunnelDefaultTagsToContact(funnelId, contactId) {
  const funnelResult = await query('SELECT default_tags FROM funnels WHERE id = $1', [funnelId]);
  const tags = funnelResult.rows[0]?.default_tags || [];
  for (const tag of tags) {
    await query(
      `UPDATE contacts SET tags = array_append(tags, $2), updated_at = now()
       WHERE id = $1 AND NOT ($2 = ANY(tags))`,
      [contactId, tag]
    );
  }
}

// Procura, entre todos os funis com entry_keyword configurado, qual palavra-chave
// aparece no texto da mensagem recebida — usado pra rotear o lead automaticamente.
export async function findFunnelByMessageKeyword(messageText) {
  if (!messageText) return null;
  // Casa o texto atual do link ou um apelido (texto antigo); o mais longo vence.
  const result = await query(
    `SELECT f.* FROM funnels f
     CROSS JOIN LATERAL unnest(array_prepend(f.entry_keyword, f.entry_keyword_aliases)) AS k(keyword)
     WHERE k.keyword IS NOT NULL AND k.keyword <> '' AND $1 ILIKE '%' || k.keyword || '%'
     ORDER BY length(k.keyword) DESC LIMIT 1`,
    [messageText]
  );
  if (!result.rows[0]) return null;

  const funnel = result.rows[0];
  const stageResult = await query(
    'SELECT * FROM funnel_stages WHERE funnel_id = $1 ORDER BY position ASC LIMIT 1',
    [funnel.id]
  );
  return { funnel, firstStage: stageResult.rows[0] || null };
}

export async function createStage(funnelId, { name, color = '#12A37D', is_closed_stage = false }) {
  const positionResult = await query(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM funnel_stages WHERE funnel_id = $1',
    [funnelId]
  );
  const position = positionResult.rows[0].next;
  const result = await query(
    'INSERT INTO funnel_stages (funnel_id, name, color, position, is_closed_stage) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [funnelId, name, color, position, is_closed_stage]
  );
  return result.rows[0];
}

// Troca a posição de uma etapa com a vizinha (anterior ou seguinte) dentro do mesmo funil.
export async function moveStage(stageId, direction) {
  const stageResult = await query('SELECT * FROM funnel_stages WHERE id = $1', [stageId]);
  const stage = stageResult.rows[0];
  if (!stage) return null;

  const neighborResult = await query(
    `SELECT * FROM funnel_stages WHERE funnel_id = $1 AND position ${direction === 'up' ? '<' : '>'} $2
     ORDER BY position ${direction === 'up' ? 'DESC' : 'ASC'} LIMIT 1`,
    [stage.funnel_id, stage.position]
  );
  const neighbor = neighborResult.rows[0];
  if (!neighbor) return stage; // já está na ponta, nada a fazer

  await query('UPDATE funnel_stages SET position = $2 WHERE id = $1', [stage.id, neighbor.position]);
  await query('UPDATE funnel_stages SET position = $2 WHERE id = $1', [neighbor.id, stage.position]);

  const result = await query('SELECT * FROM funnel_stages WHERE funnel_id = $1 ORDER BY position ASC', [stage.funnel_id]);
  return result.rows;
}

export async function renameStage(stageId, { name, color, metaEvent }) {
  const result = await query(
    `UPDATE funnel_stages SET name = COALESCE($2, name), color = COALESCE($3, color),
       meta_event = CASE WHEN $4 THEN $5 ELSE meta_event END
     WHERE id = $1 RETURNING *`,
    [stageId, name ?? null, color ?? null, metaEvent !== undefined, metaEvent || null]
  );
  return result.rows[0];
}

export async function deleteStage(stageId) {
  await query('DELETE FROM funnel_stages WHERE id = $1', [stageId]);
}

export async function renameFunnel(funnelId, name) {
  const result = await query('UPDATE funnels SET name = $2 WHERE id = $1 RETURNING *', [funnelId, name]);
  return result.rows[0];
}

export async function setDefaultFunnel(funnelId) {
  await query('UPDATE funnels SET is_default = (id = $1)', [funnelId]);
  const result = await query('SELECT * FROM funnels WHERE id = $1', [funnelId]);
  return result.rows[0];
}

export async function deleteFunnel(funnelId) {
  const result = await query('SELECT is_default FROM funnels WHERE id = $1', [funnelId]);
  if (result.rows[0]?.is_default) {
    throw Object.assign(new Error('O funil padrão não pode ser excluído — leads novos precisam de um funil de destino.'), { status: 400 });
  }
  await query('DELETE FROM funnels WHERE id = $1', [funnelId]);
}

export async function getDefaultFunnelWithFirstStage() {
  const funnelResult = await query(
    'SELECT * FROM funnels WHERE is_default = true ORDER BY position ASC LIMIT 1'
  );
  const funnel = funnelResult.rows[0];
  if (!funnel) return null;

  const stageResult = await query(
    'SELECT * FROM funnel_stages WHERE funnel_id = $1 ORDER BY position ASC LIMIT 1',
    [funnel.id]
  );
  return { funnel, firstStage: stageResult.rows[0] || null };
}
