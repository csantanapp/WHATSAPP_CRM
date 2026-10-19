-- Integrações: chaves de IA por provedor (ChatGPT e Claude conectados ao mesmo
-- tempo) e conexão com o Google Sheets (OAuth "Conectar conta Google").

CREATE TABLE IF NOT EXISTS ai_provider_keys (
  tenant_id         BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,          -- openai | anthropic | google | mistral
  api_key_encrypted TEXT NOT NULL,
  model             TEXT,                   -- vazio = modelo padrão do provedor
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_test_at      TIMESTAMPTZ,
  last_test_ok      BOOLEAN,
  PRIMARY KEY (tenant_id, provider)
);

-- A chave única que existia (do provedor escolhido em Configurações) vira a
-- chave desse provedor.
INSERT INTO ai_provider_keys (tenant_id, provider, api_key_encrypted)
  SELECT tenant_id, provider, api_key_encrypted FROM ai_settings
  WHERE api_key_encrypted IS NOT NULL AND provider IS NOT NULL AND provider <> 'mock'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS google_connections (
  tenant_id               BIGINT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  email                   TEXT,
  refresh_token_encrypted TEXT NOT NULL,
  access_token_encrypted  TEXT,
  access_token_expires_at TIMESTAMPTZ,
  connected_by            BIGINT REFERENCES users(id) ON DELETE SET NULL,
  connected_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Planilhas que o chattrack pode usar (o usuário cola o link uma vez).
CREATE TABLE IF NOT EXISTS google_sheets (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  spreadsheet_id TEXT NOT NULL,
  title          TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, spreadsheet_id)
);
