-- Fase 2 (núcleo): atribuição/transferência, status, prioridade, notas
-- internas, respostas rápidas, janela de 24h. Não destrutivo.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_priority BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

-- Aproxima o histórico existente: sem isso, toda conversa antiga pareceria
-- "janela sempre fechada" até a próxima mensagem real do contato chegar.
UPDATE conversations SET last_inbound_at = last_message_at
  WHERE last_inbound_at IS NULL AND last_message_at IS NOT NULL;

-- message = mensagem de verdade (vai/veio pelo WhatsApp) | internal_note =
-- nota do atendente, nunca sai pela Graph API.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'message';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS quick_replies (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shortcut   TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, shortcut)
);

CREATE INDEX IF NOT EXISTS idx_conversations_assigned ON conversations(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
