import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '../../db/pool.js';
import { completeMock } from './providers/mock.js';
import { completeAnthropic } from './providers/anthropic.js';
import { logger } from '../../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadPrompt(name) {
  return readFileSync(path.join(__dirname, 'prompts', `${name}.md`), 'utf8');
}

async function getSettings(tenantId) {
  const result = await query('SELECT * FROM ai_settings WHERE tenant_id = $1', [tenantId]);
  return result.rows[0] || { provider: 'mock', summarize_enabled: true, radar_enabled: true, monthly_limit: 1000 };
}

async function usageThisMonth(tenantId) {
  const result = await query(
    `SELECT count(*)::int AS count FROM ai_usage WHERE tenant_id = $1 AND created_at >= date_trunc('month', now())`,
    [tenantId]
  );
  return result.rows[0].count;
}

async function logUsage(tenantId, feature, provider, tokensIn, tokensOut) {
  await query(
    `INSERT INTO ai_usage (tenant_id, feature, provider, tokens_in, tokens_out) VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, feature, provider, tokensIn || null, tokensOut || null]
  );
}

// Núcleo: escolhe o provider certo, respeita o limite mensal, loga uso, e
// NUNCA deixa uma falha de IA quebrar o fluxo do atendimento — degrada pro
// mock (ou devolve null) e loga o erro.
async function complete({ tenantId, feature, system, messages }) {
  const settings = await getSettings(tenantId);
  const used = await usageThisMonth(tenantId);
  if (used >= settings.monthly_limit) {
    logger.info('ai_monthly_limit_reached', { tenantId, feature, used, limit: settings.monthly_limit });
    return null;
  }

  const provider = settings.provider === 'anthropic' && process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock';

  try {
    const fn = provider === 'anthropic' ? completeAnthropic : completeMock;
    const result = await fn({ system, messages, feature });
    await logUsage(tenantId, feature, provider, result.tokensIn, result.tokensOut);
    return { ...result, provider };
  } catch (err) {
    logger.error('ai_call_failed', { tenantId, feature, provider, message: err.message });
    // Degrada pro mock em vez de propagar o erro — IA não pode derrubar atendimento.
    try {
      const fallback = await completeMock({ system, messages, feature });
      await logUsage(tenantId, feature, 'mock_fallback', fallback.tokensIn, fallback.tokensOut);
      return { ...fallback, provider: 'mock_fallback' };
    } catch {
      return null;
    }
  }
}

function parseJsonSafe(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/); // tolera texto antes/depois do JSON
    return JSON.parse(match ? match[0] : text);
  } catch {
    return null;
  }
}

export async function summarizeConversation(tenantId, conversationId) {
  const messagesResult = await query(
    `SELECT direction, sender_type, body, created_at FROM messages
     WHERE conversation_id = $1 AND kind = 'message' ORDER BY created_at ASC LIMIT 60`,
    [conversationId]
  );
  if (!messagesResult.rows.length) return null;

  const transcript = messagesResult.rows
    .map((m) => `${m.direction === 'inbound' ? 'Cliente' : 'Atendente'}: ${m.body || '[mídia]'}`)
    .join('\n');

  const result = await complete({
    tenantId,
    feature: 'summarize_conversation',
    system: loadPrompt('resumo'),
    messages: [{ role: 'user', content: transcript }],
  });
  if (!result) return null;

  const parsed = parseJsonSafe(result.text) || {};
  const insertResult = await query(
    `INSERT INTO conversation_insights (tenant_id, conversation_id, summary, need, objection, product, next_step, temperature, generated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      tenantId, conversationId, parsed.summary || null, parsed.need || null, parsed.objection || null,
      parsed.product || null, parsed.next_step || null, parsed.temperature || null, result.provider,
    ]
  );
  return insertResult.rows[0];
}

export async function getLatestInsight(conversationId) {
  const result = await query(
    'SELECT * FROM conversation_insights WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1',
    [conversationId]
  );
  return result.rows[0] || null;
}

export async function generateDailyRadar(tenantId, radarData) {
  const summaryText = JSON.stringify(radarData, null, 2);
  const result = await complete({
    tenantId,
    feature: 'daily_radar',
    system: loadPrompt('radar'),
    messages: [{ role: 'user', content: summaryText }],
  });
  if (!result) return { priorities: [] };
  const parsed = parseJsonSafe(result.text) || { priorities: [] };
  return parsed;
}

export async function getAiSettings(tenantId) {
  return getSettings(tenantId);
}

export async function updateAiSettings(tenantId, { provider, summarizeEnabled, radarEnabled, monthlyLimit }) {
  const result = await query(
    `INSERT INTO ai_settings (tenant_id, provider, summarize_enabled, radar_enabled, monthly_limit)
     VALUES ($1, COALESCE($2, 'mock'), COALESCE($3, true), COALESCE($4, true), COALESCE($5, 1000))
     ON CONFLICT (tenant_id) DO UPDATE SET
       provider = COALESCE($2, ai_settings.provider),
       summarize_enabled = COALESCE($3, ai_settings.summarize_enabled),
       radar_enabled = COALESCE($4, ai_settings.radar_enabled),
       monthly_limit = COALESCE($5, ai_settings.monthly_limit),
       updated_at = now()
     RETURNING *`,
    [tenantId, provider ?? null, summarizeEnabled ?? null, radarEnabled ?? null, monthlyLimit ?? null]
  );
  return result.rows[0];
}
