import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '../../db/pool.js';
import { completeMock } from './providers/mock.js';
import { completeAnthropic, DEFAULT_MODEL as ANTHROPIC_MODEL } from './providers/anthropic.js';
import { completeOpenAI, DEFAULT_MODEL as OPENAI_MODEL } from './providers/openai.js';
import { completeGoogle, DEFAULT_MODEL as GOOGLE_MODEL } from './providers/google.js';
import { completeMistral, DEFAULT_MODEL as MISTRAL_MODEL } from './providers/mistral.js';
import { logger } from '../../logger.js';
import { encryptSecret, decryptSecret } from '../crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_MODELS = { anthropic: ANTHROPIC_MODEL, openai: OPENAI_MODEL, google: GOOGLE_MODEL, mistral: MISTRAL_MODEL };

export const AI_PROVIDERS = {
  openai: { label: 'ChatGPT (OpenAI)', fn: completeOpenAI, envFallback: 'OPENAI_API_KEY', defaultModel: DEFAULT_MODELS.openai },
  anthropic: { label: 'Claude (Anthropic)', fn: completeAnthropic, envFallback: 'ANTHROPIC_API_KEY', defaultModel: DEFAULT_MODELS.anthropic },
  google: { label: 'Google (Gemini)', fn: completeGoogle, envFallback: 'GOOGLE_API_KEY', defaultModel: DEFAULT_MODELS.google },
  mistral: { label: 'Mistral AI', fn: completeMistral, envFallback: 'MISTRAL_API_KEY', defaultModel: DEFAULT_MODELS.mistral },
};

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
async function complete({ tenantId, feature, system, messages, providerOverride }) {
  const settings = await getSettings(tenantId);
  const used = await usageThisMonth(tenantId);
  if (used >= settings.monthly_limit) {
    logger.info('ai_monthly_limit_reached', { tenantId, feature, used, limit: settings.monthly_limit });
    return null;
  }

  // Cada provedor tem a própria chave (tela Integrações); um agente pode usar
  // um provedor diferente do padrão. Sem chave, degrada pro mock.
  const providerId = providerOverride || settings.provider;
  const providerDef = AI_PROVIDERS[providerId];
  const { apiKey, model } = providerDef ? await getProviderCredentials(tenantId, providerId, settings) : { apiKey: null, model: null };
  const provider = providerDef && apiKey ? providerId : 'mock';

  try {
    const fn = provider === 'mock' ? completeMock : providerDef.fn;
    const result = await fn({ system, messages, feature, apiKey, model: model || undefined });
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

// Chave e modelo de um provedor: tabela ai_provider_keys → chave antiga única
// (ai_settings, só do provedor padrão) → variável de ambiente.
async function getProviderCredentials(tenantId, providerId, settings) {
  const providerDef = AI_PROVIDERS[providerId];
  const row = (await query('SELECT api_key_encrypted, model FROM ai_provider_keys WHERE tenant_id = $1 AND provider = $2', [tenantId, providerId])).rows[0];
  let apiKey = null;
  const stored = row?.api_key_encrypted || (providerId === settings?.provider ? settings?.api_key_encrypted : null);
  if (stored) {
    try {
      apiKey = decryptSecret(stored);
    } catch (err) {
      logger.error('ai_key_decrypt_failed', { tenantId, provider: providerId, message: err.message });
    }
  }
  if (!apiKey && providerDef) apiKey = process.env[providerDef.envFallback] || null;
  return { apiKey, model: row?.model || null };
}

// ── Integrações de IA (cartões ChatGPT / Claude) ──

export async function listAiConnections(tenantId) {
  const settings = await getSettings(tenantId);
  const rows = (await query('SELECT provider, model, connected_at, last_test_at, last_test_ok FROM ai_provider_keys WHERE tenant_id = $1', [tenantId])).rows;
  return Object.entries(AI_PROVIDERS).map(([id, def]) => {
    const row = rows.find((r) => r.provider === id);
    return {
      provider: id,
      label: def.label,
      connected: Boolean(row) || Boolean(process.env[def.envFallback]),
      via_env: !row && Boolean(process.env[def.envFallback]),
      model: row?.model || null,
      default_model: def.defaultModel,
      connected_at: row?.connected_at || null,
      last_test_at: row?.last_test_at || null,
      last_test_ok: row?.last_test_ok ?? null,
      is_default: settings.provider === id,
    };
  });
}

export async function saveAiProviderKey(tenantId, providerId, { apiKey, model }) {
  if (!AI_PROVIDERS[providerId]) throw Object.assign(new Error('Provedor de IA desconhecido'), { status: 400 });
  const cleanModel = model ? String(model).trim().slice(0, 80) : null;
  if (apiKey) {
    await query(
      `INSERT INTO ai_provider_keys (tenant_id, provider, api_key_encrypted, model) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, provider) DO UPDATE SET api_key_encrypted = EXCLUDED.api_key_encrypted, model = EXCLUDED.model,
         connected_at = now(), last_test_at = NULL, last_test_ok = NULL`,
      [tenantId, providerId, encryptSecret(String(apiKey).trim()), cleanModel]
    );
  } else {
    const updated = await query('UPDATE ai_provider_keys SET model = $3 WHERE tenant_id = $1 AND provider = $2', [tenantId, providerId, cleanModel]);
    if (!updated.rowCount) throw Object.assign(new Error('Cole a chave de API para conectar.'), { status: 400 });
  }
  // Primeiro provedor conectado vira o padrão (sai do modo de teste/mock).
  const settings = await getSettings(tenantId);
  if (!settings.provider || settings.provider === 'mock') await updateAiSettings(tenantId, { provider: providerId });
}

export async function deleteAiProviderKey(tenantId, providerId) {
  await query('DELETE FROM ai_provider_keys WHERE tenant_id = $1 AND provider = $2', [tenantId, providerId]);
  const settings = await getSettings(tenantId);
  if (settings.provider === providerId) {
    // Passa o padrão pra outro provedor conectado, se houver.
    const other = (await query('SELECT provider FROM ai_provider_keys WHERE tenant_id = $1 ORDER BY connected_at LIMIT 1', [tenantId])).rows[0];
    await query('UPDATE ai_settings SET provider = $2, api_key_encrypted = NULL, updated_at = now() WHERE tenant_id = $1', [tenantId, other?.provider || 'mock']);
  }
}

export async function setDefaultAiProvider(tenantId, providerId) {
  if (!AI_PROVIDERS[providerId]) throw Object.assign(new Error('Provedor de IA desconhecido'), { status: 400 });
  await updateAiSettings(tenantId, { provider: providerId });
}

// "Testar conexão": uma chamada mínima direto no provedor (sem cair no mock).
export async function testAiProvider(tenantId, providerId) {
  const providerDef = AI_PROVIDERS[providerId];
  if (!providerDef) throw Object.assign(new Error('Provedor de IA desconhecido'), { status: 400 });
  const { apiKey, model } = await getProviderCredentials(tenantId, providerId, await getSettings(tenantId));
  if (!apiKey) return { ok: false, message: 'Nenhuma chave conectada para este provedor.' };
  let ok = false;
  let message;
  try {
    const result = await providerDef.fn({ system: 'Responda apenas: ok', messages: [{ role: 'user', content: 'Teste de conexão. Responda apenas "ok".' }], feature: 'test', apiKey, model: model || undefined });
    ok = true;
    message = 'Conexão funcionando' + (result.text ? ' — resposta: “' + String(result.text).trim().slice(0, 40) + '”' : '') + '.';
  } catch (err) {
    message = err.message;
  }
  await query('UPDATE ai_provider_keys SET last_test_at = now(), last_test_ok = $3 WHERE tenant_id = $1 AND provider = $2', [tenantId, providerId, ok]);
  return { ok, message };
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

// Classificação binária usada pelo nó "Classificar (IA)" do construtor de
// automações — pergunta sim/não sobre o estado da conversa (ex: "o cliente
// quer marcar um horário?"). Degrada pro mock (sempre "false") se a IA falhar.
export async function classifyForAutomation(tenantId, { question, transcript }) {
  const result = await complete({
    tenantId,
    feature: 'classify_automation',
    system: loadPrompt('classificar'),
    messages: [{ role: 'user', content: `Pergunta de classificação: ${question}\n\nHistórico da conversa:\n${transcript}` }],
  });
  if (!result) return false;
  const parsed = parseJsonSafe(result.text);
  return !!(parsed && parsed.result === true);
}

// Resposta de um Agente de IA — o prompt (persona + base de conhecimento +
// regras com os marcadores [[HANDOFF]]/[[SILENCIO]]) é montado em
// src/automation/agentPrompt.js. Devolve também o provider usado, pra quem
// chama saber se a resposta veio de uma IA real ou do mock.
export async function replyAsAgent(tenantId, { systemPrompt, transcript, providerOverride }) {
  const result = await complete({
    tenantId,
    feature: 'ai_agent_reply',
    system: systemPrompt || '',
    messages: [{ role: 'user', content: transcript }],
    providerOverride: providerOverride || undefined,
  });
  return result ? { text: result.text, provider: result.provider } : null;
}

export async function getAiSettings(tenantId) {
  const settings = await getSettings(tenantId);
  // Nunca devolve a chave (nem criptografada) pro frontend — só se tem uma configurada.
  const { api_key_encrypted, ...rest } = settings;
  const { apiKey } = AI_PROVIDERS[settings.provider] ? await getProviderCredentials(tenantId, settings.provider, settings) : { apiKey: null };
  return { ...rest, has_api_key: Boolean(apiKey) || Boolean(api_key_encrypted) };
}

export async function updateAiSettings(tenantId, { provider, summarizeEnabled, radarEnabled, monthlyLimit, apiKey }) {
  const apiKeyEncrypted = apiKey ? encryptSecret(apiKey) : null;
  const result = await query(
    `INSERT INTO ai_settings (tenant_id, provider, summarize_enabled, radar_enabled, monthly_limit, api_key_encrypted)
     VALUES ($1, COALESCE($2, 'mock'), COALESCE($3, true), COALESCE($4, true), COALESCE($5, 1000), $6)
     ON CONFLICT (tenant_id) DO UPDATE SET
       provider = COALESCE($2, ai_settings.provider),
       summarize_enabled = COALESCE($3, ai_settings.summarize_enabled),
       radar_enabled = COALESCE($4, ai_settings.radar_enabled),
       monthly_limit = COALESCE($5, ai_settings.monthly_limit),
       api_key_encrypted = COALESCE($6, ai_settings.api_key_encrypted),
       updated_at = now()
     RETURNING *`,
    [tenantId, provider ?? null, summarizeEnabled ?? null, radarEnabled ?? null, monthlyLimit ?? null, apiKeyEncrypted]
  );
  const { api_key_encrypted, ...rest } = result.rows[0];
  return { ...rest, has_api_key: !!api_key_encrypted };
}
