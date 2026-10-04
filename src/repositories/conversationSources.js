import { query } from '../db/pool.js';
import { getDefaultTenantId } from '../tenant.js';

// Chamado só na criação da conversa (primeiro contato) — a origem é sempre
// do primeiro toque, não muda depois.
export async function recordConversationSource({ conversationId, contactId, referral, campaignKey }) {
  const tenantId = await getDefaultTenantId();

  let sourceType = 'direct';
  let adId = null;
  let adHeadline = null;
  let sourceUrl = null;
  let ctwaClid = null;

  if (referral) {
    sourceType = 'referral_ad';
    adId = referral.source_id || null;
    adHeadline = referral.headline || null;
    sourceUrl = referral.source_url || null;
    ctwaClid = referral.ctwa_clid || null;
  } else if (campaignKey) {
    sourceType = 'campaign_keyword';
  }

  const result = await query(
    `INSERT INTO conversation_sources (tenant_id, conversation_id, contact_id, source_type, campaign_key, ad_id, ad_headline, source_url, ctwa_clid, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tenantId, conversationId, contactId, sourceType, campaignKey || null, adId, adHeadline, sourceUrl, ctwaClid, JSON.stringify(referral || {})]
  );
  return result.rows[0];
}

export async function getSourceForConversation(conversationId) {
  const result = await query('SELECT * FROM conversation_sources WHERE conversation_id = $1', [conversationId]);
  return result.rows[0];
}
