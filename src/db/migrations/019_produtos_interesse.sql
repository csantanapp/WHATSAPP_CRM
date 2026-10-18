-- Histórico de produtos de interesse do lead (seção Contatos). Cada linha é
-- um registro com data e origem: manual (ficha do lead), form (resposta de um
-- nó "Pergunta" de automação) ou opportunity (oportunidade criada).

CREATE TABLE IF NOT EXISTS contact_interests (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  product         TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual', -- manual | form | opportunity
  source_label    TEXT,                           -- nome da automação / da oportunidade
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
  created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_interests_contact ON contact_interests(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_interests_product ON contact_interests(tenant_id, lower(product));
