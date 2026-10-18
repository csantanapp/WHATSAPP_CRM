-- Métricas por nó do construtor de automação (estilo ManyChat): de qual nó saiu
-- cada mensagem, qual opção o lead escolheu e um log leve de cada execução de nó.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS automation_step_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_messages_automation_step ON messages(automation_step_id) WHERE automation_step_id IS NOT NULL;

ALTER TABLE automation_run_answers ADD COLUMN IF NOT EXISTS option_index INT;

CREATE TABLE IF NOT EXISTS automation_step_logs (
  id              BIGSERIAL PRIMARY KEY,
  automation_flow_id BIGINT NOT NULL REFERENCES automation_flows(id) ON DELETE CASCADE,
  step_id         BIGINT NOT NULL,   -- sem FK: o histórico sobrevive se o nó for removido
  run_id          BIGINT REFERENCES automation_runs(id) ON DELETE CASCADE,
  conversation_id BIGINT,
  outcome         TEXT,              -- 'true'/'false' em condições; 'skipped_known' em pergunta pulada
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_step_logs_flow_date ON automation_step_logs(automation_flow_id, created_at);
