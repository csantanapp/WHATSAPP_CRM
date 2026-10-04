import { query } from './db/pool.js';

// Hoje existe um único tenant real (Tractom) — usado para carimbar tenant_id
// em dados criados fora de uma requisição autenticada (webhook do WhatsApp,
// que não tem sessão de usuário). Quando houver um segundo tenant de verdade,
// o webhook passa a resolver o tenant pelo phone_number_id via
// `whatsapp_accounts` (tabela já existe, ver migrations/001_fundamento.sql) —
// esse é o próximo passo antes de onboardar outro cliente.
let cachedDefaultTenantId = null;

export async function getDefaultTenantId() {
  if (cachedDefaultTenantId) return cachedDefaultTenantId;
  const result = await query("SELECT id FROM tenants WHERE slug = 'tractom' LIMIT 1");
  cachedDefaultTenantId = result.rows[0]?.id ?? null;
  return cachedDefaultTenantId;
}
