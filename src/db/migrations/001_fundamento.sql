-- Fase 1 — Fundamento: multi-tenant, autenticação, usuários, auditoria.
-- Não destrutivo: tenant_id entra NULLABLE, backfill roda logo abaixo, só
-- depois (migration seguinte, após validar) viraria NOT NULL.

CREATE TABLE IF NOT EXISTS tenants (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT UNIQUE NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active', -- active | suspended
  timezone   TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'atendente', -- admin | supervisor | atendente
  is_platform_admin BOOLEAN NOT NULL DEFAULT false,     -- super-admin Tractom, cria tenants
  status            TEXT NOT NULL DEFAULT 'active',      -- active | disabled
  last_login_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- Tabela de sessão do connect-pg-simple (nome e colunas no formato que a lib espera).
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    varchar NOT NULL COLLATE "default",
  "sess"   json NOT NULL,
  "expire" timestamp(6) NOT NULL
) WITH (OIDS=FALSE);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
  ) THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT REFERENCES tenants(id) ON DELETE SET NULL,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entity_type TEXT,
  entity_id  TEXT,
  metadata   JSONB NOT NULL DEFAULT '{}',
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id, created_at DESC);

-- Credenciais do WhatsApp por tenant (hoje só um tenant real, mas já isolado).
CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number_id       TEXT UNIQUE NOT NULL,
  waba_id               TEXT NOT NULL,
  display_phone         TEXT,
  access_token_encrypted TEXT NOT NULL,
  verify_token          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  last_validated_at     TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- tenant_id nas tabelas de negócio existentes (nullable por enquanto).
ALTER TABLE contacts            ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tenants(id);
ALTER TABLE tags                ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tenants(id);
ALTER TABLE funnels             ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tenants(id);
ALTER TABLE conversations        ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tenants(id);
ALTER TABLE messages            ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tenants(id);
ALTER TABLE automation_flows    ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tenants(id);
ALTER TABLE activity_log        ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tenants(id);
ALTER TABLE app_settings        ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tenants(id);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- Backfill: cria o tenant Tractom e atribui a ele tudo que já existe.
INSERT INTO tenants (name, slug)
  SELECT 'Tractom', 'tractom'
  WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE slug = 'tractom');

UPDATE contacts         SET tenant_id = (SELECT id FROM tenants WHERE slug = 'tractom') WHERE tenant_id IS NULL;
UPDATE tags              SET tenant_id = (SELECT id FROM tenants WHERE slug = 'tractom') WHERE tenant_id IS NULL;
UPDATE funnels           SET tenant_id = (SELECT id FROM tenants WHERE slug = 'tractom') WHERE tenant_id IS NULL;
UPDATE conversations      SET tenant_id = (SELECT id FROM tenants WHERE slug = 'tractom') WHERE tenant_id IS NULL;
UPDATE messages           SET tenant_id = (SELECT id FROM tenants WHERE slug = 'tractom') WHERE tenant_id IS NULL;
UPDATE automation_flows   SET tenant_id = (SELECT id FROM tenants WHERE slug = 'tractom') WHERE tenant_id IS NULL;
UPDATE activity_log       SET tenant_id = (SELECT id FROM tenants WHERE slug = 'tractom') WHERE tenant_id IS NULL;
UPDATE app_settings       SET tenant_id = (SELECT id FROM tenants WHERE slug = 'tractom') WHERE tenant_id IS NULL;

-- Índices usados em toda query filtrada por tenant.
CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tags_tenant ON tags(tenant_id);
CREATE INDEX IF NOT EXISTS idx_funnels_tenant ON funnels(tenant_id);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_automation_flows_tenant ON automation_flows(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
