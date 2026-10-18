-- Bloco "Conectar Agente IA" das automações: o fluxo fixa um Agente de IA na
-- conversa, que passa a responder ali independentemente dos gatilhos dele
-- (palavra-chave, horário, funil). Some se o agente for excluído.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_agent_id BIGINT REFERENCES ai_agents(id) ON DELETE SET NULL;
