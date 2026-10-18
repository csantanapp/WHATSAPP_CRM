-- Agente de IA com base de conhecimento (ideias adaptadas do Vocero CRM, MIT):
-- responde só com o que sabe, junta mensagens seguidas antes de responder e,
-- ao passar pra um humano, avisa o cliente e para de responder naquela conversa.

ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS knowledge_faq JSONB NOT NULL DEFAULT '[]'::jsonb; -- [{q, a}]
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS knowledge_text TEXT;                              -- informações livres
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS only_from_knowledge BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS wait_seconds INT NOT NULL DEFAULT 6;              -- agrupar rajadas
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS handoff_message TEXT;                             -- o que o cliente ouve no handoff

-- IA pausada numa conversa específica (passou pra humano ou atendente assumiu).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_paused_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_paused_reason TEXT;
