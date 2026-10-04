-- Fase 4 (núcleo): infra de jobs agendados, novos gatilhos/ações do motor,
-- distribuição round-robin, opt-in/opt-out (LGPD). Não destrutivo.

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,              -- ex: 'automation_resume'
  run_at     TIMESTAMPTZ NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed
  attempts   INT NOT NULL DEFAULT 0,
  last_error TEXT,
  locked_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs(run_at) WHERE status = 'pending';

-- Distribuição automática de conversas não atribuídas.
CREATE TABLE IF NOT EXISTS distribution_rules (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL DEFAULT 'manual', -- manual | round_robin
  participant_user_ids BIGINT[] NOT NULL DEFAULT '{}',
  last_assigned_index INT NOT NULL DEFAULT -1,
  is_active       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- Opt-in/opt-out de marketing (LGPD) — por contato.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS opt_in_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;

-- Passos de automação ganham condição com dois ramos (sim/não) — mantém
-- next_step_id pros passos lineares existentes, sem quebrar nada.
ALTER TABLE automation_flow_steps ADD COLUMN IF NOT EXISTS next_step_id_true BIGINT REFERENCES automation_flow_steps(id) ON DELETE SET NULL;
ALTER TABLE automation_flow_steps ADD COLUMN IF NOT EXISTS next_step_id_false BIGINT REFERENCES automation_flow_steps(id) ON DELETE SET NULL;
