-- Conversions API da Meta (business_messaging): avisa a Meta quando um lead que
-- veio de anúncio Click-to-WhatsApp vira "lead qualificado" ou "venda", pra ela
-- otimizar os anúncios pra quem compra, não pra quem só manda mensagem.

-- Qual evento cada etapa dispara ao receber uma conversa: 'QualifiedLead' |
-- 'Purchase' | NULL (nenhum). Por etapa porque cada funil tem as suas.
ALTER TABLE funnel_stages ADD COLUMN IF NOT EXISTS meta_event TEXT;

-- Registro de tudo que foi (ou não) reportado. UNIQUE garante 1 evento de cada
-- tipo por conversa: à Meta não dá pra "desmandar" uma venda.
CREATE TABLE IF NOT EXISTS conversion_events (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id      BIGINT REFERENCES contacts(id) ON DELETE CASCADE,
  event_name      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | skipped
  value           NUMERIC(14,2),
  currency        TEXT,
  trigger         TEXT,  -- o que disparou: "etapa X" / "oportunidade ganha"
  error           TEXT,  -- motivo de failed/skipped, como a Meta (ou o CRM) disse
  fbtrace_id      TEXT,  -- referência que o suporte da Meta pede
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  UNIQUE (conversation_id, event_name)
);
CREATE INDEX IF NOT EXISTS idx_conversion_events_created ON conversion_events(created_at DESC);
