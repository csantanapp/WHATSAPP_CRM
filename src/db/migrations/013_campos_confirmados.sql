-- Dados do lead confirmados por uma pessoa (respondidos num formulário ou
-- editados por um atendente). O nó "Pergunta" com "Pular se o lead já tiver
-- esse dado" só pula nome/e-mail confirmados — o nome que vem do perfil do
-- WhatsApp/Instagram não conta (costuma ser apelido, emoji ou nome de empresa).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS confirmed_fields TEXT[] NOT NULL DEFAULT '{}';

-- E-mail nunca vem do perfil: se existe, foi digitado por alguém.
UPDATE contacts SET confirmed_fields = array_append(confirmed_fields, 'email')
WHERE email IS NOT NULL AND email <> '' AND NOT ('email' = ANY(confirmed_fields));

-- Nome respondido em formulário antes desta migration.
UPDATE contacts c SET confirmed_fields = array_append(confirmed_fields, 'name')
WHERE NOT ('name' = ANY(confirmed_fields))
  AND EXISTS (
    SELECT 1 FROM activity_log a
    WHERE a.contact_id = c.id AND a.type = 'form_answer' AND a.description LIKE 'Nome informado no formulário%'
  );
