-- Agentes de IA: versão enxuta inspirada no módulo "AI Agents" do DeskcommCRM
-- (sem tool-calling/MCP, sem versionamento — cada agente é uma persona com
-- prompt de sistema própria que responde mensagens automaticamente).

CREATE TABLE IF NOT EXISTS ai_agents (
  id                      BIGSERIAL PRIMARY KEY,
  tenant_id               BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  description             TEXT,
  system_prompt           TEXT NOT NULL DEFAULT '',
  provider                TEXT,                      -- NULL = usa o provider padrão da conta (ai_settings)
  funnel_id               BIGINT REFERENCES funnels(id) ON DELETE SET NULL, -- NULL = todos os funis
  is_active               BOOLEAN NOT NULL DEFAULT false,
  priority                INT NOT NULL DEFAULT 0,     -- maior = roda primeiro quando mais de um agente casa
  keyword_regex           TEXT,                       -- NULL = responde qualquer mensagem
  ignore_groups           BOOLEAN NOT NULL DEFAULT true,
  business_hours_enabled  BOOLEAN NOT NULL DEFAULT false,
  business_hours_tz       TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  business_hours_start    TEXT NOT NULL DEFAULT '09:00',
  business_hours_end      TEXT NOT NULL DEFAULT '18:00',
  allow_handoff           BOOLEAN NOT NULL DEFAULT true,  -- agente pode decidir pedir atendente humano
  handoff_keywords        TEXT[] NOT NULL DEFAULT '{}',   -- bypass direto pro handoff, sem chamar a IA
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_agents_tenant_active ON ai_agents(tenant_id, is_active);

-- Log leve de execuções — só o suficiente pra mostrar "142 runs hoje" na lista,
-- sem a trace completa de tool-calling do DeskcommCRM.
CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ai_agent_id     BIGINT NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
  outcome         TEXT NOT NULL,  -- replied | handoff | error
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_agent_date ON ai_agent_runs(ai_agent_id, created_at);
