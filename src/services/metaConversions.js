import { query } from '../db/pool.js';
import { wa } from '../whatsapp/credentials.js';
import { getSetting, setSetting } from '../repositories/settings.js';
import { logger } from '../logger.js';

// Conversions API da Meta, variante business_messaging (anúncios Click-to-WhatsApp).
//
// Regras (aprendidas com o Vocero CRM, que opera isso em produção):
// 1. Um evento de cada tipo por conversa — dedup no banco (UNIQUE), a linha é
//    criada ANTES de falar com a Meta. Não dá pra "desmandar" uma venda.
// 2. Melhor esforço: nada aqui pode impedir o lead de mudar de etapa. Quem
//    chama não espera (fire-and-forget) e erros só ficam registrados.
// 3. Todo intento deixa rastro: sent / failed / skipped com o motivo.
// 4. A Meta responde 200 mesmo descartando o evento: o único acuse real é
//    events_received >= 1.
// 5. Não existe evento de teste: o ctwa_clid precisa ser de um clique real.
// Nunca viaja telefone, nome ou texto do contato — só o id do clique e da WABA.

const GRAPH = 'https://graph.facebook.com/v21.0';
const PARTNER_AGENT = 'tractom-crm-whatsapp';
export const SUPPORTED_EVENTS = ['QualifiedLead', 'Purchase'];
// A Meta mede a atribuição em dias; lead que volta depois disso não é do anúncio.
const ATTRIBUTION_WINDOW_DAYS = 28;

export async function getConversionsConfig() {
  return {
    enabled: (await getSetting('capi_enabled')) === 'true',
    datasetId: (await getSetting('capi_dataset_id')) || null,
    wabaId: wa().wabaId || null,
    hasToken: Boolean(wa().accessToken),
  };
}

export async function updateConversionsConfig({ enabled, datasetId }) {
  if (enabled !== undefined) await setSetting('capi_enabled', enabled ? 'true' : 'false');
  if (datasetId !== undefined) await setSetting('capi_dataset_id', String(datasetId || '').trim());
  return getConversionsConfig();
}

// O dataset de mensagens é o da própria conta do WhatsApp: POST {waba}/dataset
// devolve o id (e é idempotente — repetir devolve o mesmo).
export async function ensureDataset() {
  const { wabaId } = await getConversionsConfig();
  if (!wabaId || !wa().accessToken) throw new Error('WhatsApp não configurado (WABA ou token ausente)');
  const res = await fetch(`${GRAPH}/${wabaId}/dataset`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${wa().accessToken}` },
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!res.ok || !data?.id) throw new Error(data?.error?.message || `Falha ao obter o dataset (${res.status})`);
  await setSetting('capi_dataset_id', data.id);
  return data.id;
}

export function buildEventPayload({ eventName, eventTime, ctwaClid, wabaId, customData }) {
  const event = {
    event_name: eventName,
    event_time: eventTime,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: { ctwa_clid: ctwaClid, whatsapp_business_account_id: wabaId },
  };
  if (customData && Object.keys(customData).length) event.custom_data = customData;
  return { data: [event], partner_agent: PARTNER_AGENT };
}

// Clique do anúncio desta conversa; se a conversa não tem (lead que voltou e
// abriu conversa nova), o clique mais recente do mesmo contato dentro da janela.
async function findCtwaClid(conversationId, contactId) {
  const own = await query(
    `SELECT ctwa_clid FROM conversation_sources WHERE conversation_id = $1 AND ctwa_clid IS NOT NULL ORDER BY id LIMIT 1`,
    [conversationId]
  );
  if (own.rows[0]) return own.rows[0].ctwa_clid;
  const recent = await query(
    `SELECT ctwa_clid FROM conversation_sources
     WHERE contact_id = $1 AND ctwa_clid IS NOT NULL AND created_at > now() - ($2 || ' days')::interval
     ORDER BY created_at DESC LIMIT 1`,
    [contactId, String(ATTRIBUTION_WINDOW_DAYS)]
  );
  return recent.rows[0]?.ctwa_clid || null;
}

async function finish(id, fields) {
  await query(
    `UPDATE conversion_events SET status = $2, error = $3, fbtrace_id = $4,
       sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
     WHERE id = $1`,
    [id, fields.status, fields.error || null, fields.fbtraceId || null]
  );
  return fields.status;
}

export async function emitConversion({ conversationId, eventName, value = null, currency = 'BRL', trigger = null }) {
  try {
    if (!SUPPORTED_EVENTS.includes(eventName)) return 'unsupported';
    const config = await getConversionsConfig();
    if (!config.enabled) return 'disabled';

    const conv = await query('SELECT id, tenant_id, contact_id FROM conversations WHERE id = $1', [conversationId]);
    const conversation = conv.rows[0];
    if (!conversation) return 'no_conversation';

    // Venda sem valor (ou zero) vai sem preço: value 0 ensinaria à Meta que as vendas valem nada.
    const numericValue = value != null && Number(value) > 0 ? Number(value) : null;
    const inserted = await query(
      `INSERT INTO conversion_events (tenant_id, conversation_id, contact_id, event_name, value, currency, trigger)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (conversation_id, event_name) DO NOTHING RETURNING id`,
      [conversation.tenant_id, conversation.id, conversation.contact_id, eventName, numericValue, numericValue ? currency : null, trigger]
    );
    const row = inserted.rows[0];
    if (!row) return 'dedup';

    const ctwaClid = await findCtwaClid(conversation.id, conversation.contact_id);
    if (!ctwaClid) return finish(row.id, { status: 'skipped', error: 'A conversa não veio de um anúncio Click-to-WhatsApp (sem identificador de clique)' });
    if (!config.datasetId || !config.wabaId || !config.hasToken) {
      return finish(row.id, { status: 'skipped', error: 'Conversões não configuradas: falta o dataset da Meta ou a conexão do WhatsApp' });
    }

    const customData = { lead_stage: eventName === 'Purchase' ? 'won' : 'qualified' };
    if (eventName === 'Purchase' && numericValue) Object.assign(customData, { value: numericValue, currency });

    try {
      const res = await fetch(`${GRAPH}/${config.datasetId}/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${wa().accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildEventPayload({
          eventName,
          eventTime: Math.floor(Date.now() / 1000),
          ctwaClid,
          wabaId: config.wabaId,
          customData,
        })),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return finish(row.id, { status: 'failed', error: data?.error?.message || `Meta respondeu ${res.status}`, fbtraceId: data?.error?.fbtrace_id });
      }
      if (!(data.events_received >= 1)) {
        return finish(row.id, { status: 'failed', error: `Meta respondeu 200 mas descartou o evento (events_received=${data.events_received ?? 0})`, fbtraceId: data.fbtrace_id });
      }
      return finish(row.id, { status: 'sent', fbtraceId: data.fbtrace_id });
    } catch (err) {
      return finish(row.id, { status: 'failed', error: `Falha de rede: ${err.message}` });
    }
  } catch (err) {
    logger.error('meta_conversion_failed', { conversationId, eventName, message: err.message });
    return 'error';
  }
}

// Valor da venda: oportunidade ganha mais recente do contato; senão a aberta mais recente.
async function opportunityValueFor(contactId) {
  const result = await query(
    `SELECT value FROM opportunities WHERE contact_id = $1 AND status IN ('won','open') AND value > 0
     ORDER BY (status = 'won') DESC, coalesce(won_at, updated_at) DESC LIMIT 1`,
    [contactId]
  );
  return result.rows[0]?.value ?? null;
}

// Chamado quando uma conversa entra numa etapa (Kanban, automação, redirecionamento).
export async function reportStageChange(conversationId, stageId) {
  try {
    const stage = await query('SELECT name, meta_event FROM funnel_stages WHERE id = $1', [stageId]);
    const metaEvent = stage.rows[0]?.meta_event;
    if (!SUPPORTED_EVENTS.includes(metaEvent)) return 'no_event';
    let value = null;
    if (metaEvent === 'Purchase') {
      const conv = await query('SELECT contact_id FROM conversations WHERE id = $1', [conversationId]);
      value = conv.rows[0] ? await opportunityValueFor(conv.rows[0].contact_id) : null;
    }
    return emitConversion({ conversationId, eventName: metaEvent, value, trigger: `Etapa "${stage.rows[0].name}"` });
  } catch (err) {
    logger.error('meta_conversion_stage_failed', { conversationId, message: err.message });
    return 'error';
  }
}

// Chamado quando uma oportunidade é marcada como ganha.
export async function reportOpportunityWon(opportunity) {
  try {
    let conversationId = opportunity.conversation_id;
    if (!conversationId) {
      const latest = await query('SELECT id FROM conversations WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1', [opportunity.contact_id]);
      conversationId = latest.rows[0]?.id;
    }
    if (!conversationId) return 'no_conversation';
    return emitConversion({ conversationId, eventName: 'Purchase', value: opportunity.value, trigger: `Oportunidade ganha: ${opportunity.title}` });
  } catch (err) {
    logger.error('meta_conversion_opportunity_failed', { opportunityId: opportunity?.id, message: err.message });
    return 'error';
  }
}

export async function listConversionEvents(limit = 30) {
  const result = await query(
    `SELECT ce.*, ct.name AS contact_name, ct.phone_display
     FROM conversion_events ce LEFT JOIN contacts ct ON ct.id = ce.contact_id
     ORDER BY ce.created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}
