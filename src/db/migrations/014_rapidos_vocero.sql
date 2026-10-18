-- Contato "sem automação": IA e fluxos de automação não respondem esse contato
-- (clientes antigos/da casa, atendidos só por pessoas). As mensagens continuam
-- chegando normalmente no Inbox.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS bot_paused BOOLEAN NOT NULL DEFAULT false;

-- Motivo de falha de entrega que a Meta devolve no webhook de status
-- (ex: "Recipient phone number not in allowed list", janela de 24h fechada).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS error_message TEXT;
