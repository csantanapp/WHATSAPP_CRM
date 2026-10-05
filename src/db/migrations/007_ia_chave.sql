-- Permite guardar a chave de API da IA direto no painel (criptografada),
-- sem precisar editar .env no servidor. Fica por tenant, como o resto de
-- ai_settings.
ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT;
