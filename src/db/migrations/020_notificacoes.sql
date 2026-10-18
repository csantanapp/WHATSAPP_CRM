-- Sino de notificações: uma linha por usuário que deve ver o aviso (fan-out na
-- criação), com read_at próprio de cada um.

CREATE TABLE IF NOT EXISTS notifications (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,   -- new_lead | ai_handoff | assigned | task
  title           TEXT NOT NULL,
  body            TEXT,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id      BIGINT REFERENCES contacts(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id) WHERE read_at IS NULL;
