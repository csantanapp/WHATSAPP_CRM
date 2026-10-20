-- Troca de senha obrigatória no primeiro acesso: o admin do cliente recebe uma
-- senha provisória (gerada na instalação) e só usa o sistema depois de criar a dele.

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
