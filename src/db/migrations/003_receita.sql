-- Fase 3 (núcleo): origem/atribuição, oportunidades, follow-up, base pro
-- dashboard comercial. Não destrutivo.

ALTER TABLE funnel_stages ADD COLUMN IF NOT EXISTS is_won BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE funnel_stages ADD COLUMN IF NOT EXISTS is_lost BOOLEAN NOT NULL DEFAULT false;

-- Origem de cada conversa: captura o objeto `referral` de mensagens vindas de
-- anúncios Click-to-WhatsApp, ou a palavra-chave do link wa.me que já existia
-- (ver funnels.entry_keyword) — sem duplicar o que já funciona.
CREATE TABLE IF NOT EXISTS conversation_sources (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id    BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL, -- referral_ad | campaign_keyword | direct
  campaign_key  TEXT,          -- entry_keyword do funil, quando for esse o caso
  ad_id         TEXT,
  ad_headline   TEXT,
  source_url    TEXT,
  ctwa_clid     TEXT,          -- usado futuramente pra Conversions API
  raw           JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_sources_conversation ON conversation_sources(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_sources_contact ON conversation_sources(contact_id);

CREATE TABLE IF NOT EXISTS loss_reasons (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

INSERT INTO loss_reasons (tenant_id, name)
  SELECT t.id, reason
  FROM tenants t, (VALUES ('Preço'), ('Timing'), ('Concorrente'), ('Sem resposta'), ('Sem fit'), ('Outro')) AS r(reason)
  WHERE t.slug = 'tractom'
  ON CONFLICT (tenant_id, name) DO NOTHING;

CREATE TABLE IF NOT EXISTS opportunities (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id     BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
  funnel_id      BIGINT REFERENCES funnels(id) ON DELETE SET NULL,
  stage_id       BIGINT REFERENCES funnel_stages(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  value          NUMERIC(14,2),
  product        TEXT,
  status         TEXT NOT NULL DEFAULT 'open', -- open | won | lost
  loss_reason_id BIGINT REFERENCES loss_reasons(id) ON DELETE SET NULL,
  won_at         TIMESTAMPTZ,
  lost_at        TIMESTAMPTZ,
  owner_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  expected_close_date DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opportunities_tenant_status ON opportunities(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_opportunities_contact ON opportunities(contact_id);

CREATE TABLE IF NOT EXISTS tasks (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      BIGINT REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
  opportunity_id  BIGINT REFERENCES opportunities(id) ON DELETE SET NULL,
  assigned_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  due_at          TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | completed | cancelled
  completed_at    TIMESTAMPTZ,
  created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status ON tasks(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_user_id, due_at);
