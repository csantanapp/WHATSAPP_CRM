-- Fase 5 (núcleo): camada de IA — resumo/classificação de conversa e radar
-- diário. Arquitetura plugável (provider real vs mock), liga/desliga por
-- tenant, limite mensal, uso registrado pra custo nunca ser surpresa.

CREATE TABLE IF NOT EXISTS ai_settings (
  tenant_id         BIGINT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL DEFAULT 'mock', -- mock | anthropic
  summarize_enabled BOOLEAN NOT NULL DEFAULT true,
  radar_enabled     BOOLEAN NOT NULL DEFAULT true,
  monthly_limit     INT NOT NULL DEFAULT 1000, -- nº de chamadas de IA por mês
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature    TEXT NOT NULL, -- summarize_conversation | daily_radar | classify_lead
  provider   TEXT NOT NULL,
  tokens_in  INT,
  tokens_out INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant_month ON ai_usage(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS conversation_insights (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  summary         TEXT,
  need            TEXT,
  objection       TEXT,
  product         TEXT,
  next_step       TEXT,
  temperature     TEXT, -- quente | morno | frio
  generated_by    TEXT NOT NULL DEFAULT 'mock',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_insights_conversation ON conversation_insights(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS daily_radar_results (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  raw_data    JSONB NOT NULL,
  priorities  JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_radar_results_tenant ON daily_radar_results(tenant_id, created_at DESC);

INSERT INTO ai_settings (tenant_id)
  SELECT id FROM tenants WHERE slug = 'tractom'
  ON CONFLICT (tenant_id) DO NOTHING;
