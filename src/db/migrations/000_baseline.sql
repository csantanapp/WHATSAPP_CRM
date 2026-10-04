-- CRM WhatsApp Kanban — schema inicial (Postgres)

-- Configurações simples de app (chave/valor), editáveis pela UI sem precisar de redeploy.
-- Uso principal: número público do WhatsApp pra gerar links wa.me antes mesmo da API
-- oficial da Meta estar 100% configurada (link não precisa de access token, só do número).
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
  id            BIGSERIAL PRIMARY KEY,
  wa_id         TEXT UNIQUE NOT NULL,        -- número no formato E.164 sem "+" (padrão Meta)
  name          TEXT,
  email         TEXT,
  phone_display TEXT,
  avatar_initials TEXT,
  source        TEXT,                        -- ex: "Instagram Ads", "Site", "Indicação"
  tags          TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT;

-- Catálogo de tags reutilizáveis entre leads — gerenciado na tela de Funis,
-- pra não depender de digitar o mesmo nome de tag toda vez em texto livre.
CREATE TABLE IF NOT EXISTS tags (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  color      TEXT NOT NULL DEFAULT '#5B5F58',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS funnels (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  color          TEXT NOT NULL DEFAULT '#12A37D',
  position       INT NOT NULL DEFAULT 0,
  is_default     BOOLEAN NOT NULL DEFAULT false,
  entry_keyword  TEXT UNIQUE,   -- palavra-chave embutida no link wa.me que roteia o lead pra este funil automaticamente
  welcome_message TEXT,         -- mensagem de boas-vindas específica desta campanha/funil (sobrepõe a automação genérica)
  default_tags   TEXT[] NOT NULL DEFAULT '{}', -- tags aplicadas automaticamente a todo lead que entra neste funil
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE funnels ADD COLUMN IF NOT EXISTS default_tags TEXT[] NOT NULL DEFAULT '{}';

-- Migração incremental: adiciona as colunas em bancos que já existiam antes desta versão do schema.
ALTER TABLE funnels ADD COLUMN IF NOT EXISTS entry_keyword TEXT UNIQUE;
ALTER TABLE funnels ADD COLUMN IF NOT EXISTS welcome_message TEXT;

CREATE TABLE IF NOT EXISTS funnel_stages (
  id          BIGSERIAL PRIMARY KEY,
  funnel_id   BIGINT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#12A37D',
  position    INT NOT NULL DEFAULT 0,
  is_closed_stage BOOLEAN NOT NULL DEFAULT false, -- marca etapas terminais (ex: "Fechado")
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id              BIGSERIAL PRIMARY KEY,
  contact_id      BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  funnel_id       BIGINT REFERENCES funnels(id) ON DELETE SET NULL,
  funnel_stage_id BIGINT REFERENCES funnel_stages(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'open', -- open | pending | closed
  priority        TEXT,                         -- ex: "urgente"
  assigned_to     TEXT,                         -- referência a usuário/atendente (futuro: users table)
  unread_count    INT NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_stage ON conversations(funnel_stage_id);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);

CREATE TABLE IF NOT EXISTS messages (
  id                BIGSERIAL PRIMARY KEY,
  conversation_id   BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  wa_message_id     TEXT UNIQUE,               -- id retornado pela Cloud API
  direction         TEXT NOT NULL,             -- inbound | outbound
  sender_type       TEXT NOT NULL DEFAULT 'contact', -- contact | agent | automation
  body              TEXT,
  media_url         TEXT,
  media_type        TEXT,
  status            TEXT NOT NULL DEFAULT 'sent', -- sent | delivered | read | failed
  automation_flow_id BIGINT,                    -- preenchido quando sender_type = automation
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS automation_flows (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  funnel_id   BIGINT REFERENCES funnels(id) ON DELETE SET NULL, -- NULL = roda em qualquer funil
  trigger_type TEXT NOT NULL,   -- first_message | keyword | tag_added | stage_entered | manual
  trigger_config JSONB NOT NULL DEFAULT '{}',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE automation_flows ADD COLUMN IF NOT EXISTS funnel_id BIGINT REFERENCES funnels(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS automation_flow_steps (
  id                BIGSERIAL PRIMARY KEY,
  automation_flow_id BIGINT NOT NULL REFERENCES automation_flows(id) ON DELETE CASCADE,
  step_type         TEXT NOT NULL,   -- send_message | ask_question | add_tag | move_stage | delay | condition
  config            JSONB NOT NULL DEFAULT '{}',
  position          INT NOT NULL DEFAULT 0,
  next_step_id      BIGINT REFERENCES automation_flow_steps(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id                BIGSERIAL PRIMARY KEY,
  automation_flow_id BIGINT NOT NULL REFERENCES automation_flows(id) ON DELETE CASCADE,
  conversation_id   BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  current_step_id   BIGINT REFERENCES automation_flow_steps(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'running', -- running | waiting_reply | completed | stopped
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);

-- Histórico de atividades do lead (entrada em funil, mudança de etapa, tags etc.),
-- mostrado no perfil do lead na Gestão de Leads e no painel da conversa.
CREATE TABLE IF NOT EXISTS activity_log (
  id             BIGSERIAL PRIMARY KEY,
  contact_id     BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
  type           TEXT NOT NULL,   -- entered_funnel | stage_changed | funnel_changed | tag_added | tag_removed
  description    TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_contact ON activity_log(contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS automation_run_answers (
  id              BIGSERIAL PRIMARY KEY,
  automation_run_id BIGINT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  step_id         BIGINT NOT NULL REFERENCES automation_flow_steps(id) ON DELETE CASCADE,
  answer          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
