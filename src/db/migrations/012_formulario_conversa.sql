-- Formulário em conversa: o nó "Perguntar" do construtor de automação pode
-- gravar a resposta do lead direto na ficha (nome/e-mail) ou num campo
-- personalizado, validar o formato e oferecer botões/lista de opções.

-- Campos personalizados do lead (ex: {"interesse": "Tráfego pago", "orcamento": "5000"}).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Respostas que não passaram na validação ficam registradas (is_valid = false)
-- e servem pra contar quantas tentativas o lead já usou naquela pergunta.
ALTER TABLE automation_run_answers ADD COLUMN IF NOT EXISTS is_valid BOOLEAN NOT NULL DEFAULT true;
