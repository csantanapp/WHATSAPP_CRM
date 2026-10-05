-- Integração Instagram DM: reaproveita contacts/conversations/messages que já
-- existem (contact_id amarra tudo, independente de canal) — só precisa saber
-- de qual canal cada contato veio e qual é o identificador dele lá.

ALTER TABLE contacts ALTER COLUMN wa_id DROP NOT NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ig_user_id TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_contacts_channel ON contacts(channel);
