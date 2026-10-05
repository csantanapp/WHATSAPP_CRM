-- Fase: editor visual de automação (canvas com nós soltos, conectados por
-- linhas, arrastar/zoom/pan). Guarda a posição de cada nó e do gatilho pra
-- reabrir o fluxo exatamente como a pessoa organizou.

ALTER TABLE automation_flows ADD COLUMN IF NOT EXISTS trigger_position_x INT NOT NULL DEFAULT 60;
ALTER TABLE automation_flows ADD COLUMN IF NOT EXISTS trigger_position_y INT NOT NULL DEFAULT 160;

ALTER TABLE automation_flow_steps ADD COLUMN IF NOT EXISTS position_x INT NOT NULL DEFAULT 0;
ALTER TABLE automation_flow_steps ADD COLUMN IF NOT EXISTS position_y INT NOT NULL DEFAULT 0;
