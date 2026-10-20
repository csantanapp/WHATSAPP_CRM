# Infra do chatpipe (instâncias por cliente)

Uma VPS roda vários clientes. Cada cliente tem sua própria instância do app
(container `chatpipe-<slug>`), banco próprio no Postgres compartilhado,
mídias próprias e segredos próprios. Endereço: `https://<slug>.chatpipe.com.br`.

```
/opt/chatpipe/
  src/                 # este repositório (git clone)
  stack/               # Caddy (HTTPS) + Postgres + Whisper, compartilhados
    .env               # POSTGRES_PASSWORD
    Caddyfile, sites/  # um arquivo .caddy por cliente
  clientes/<slug>/     # docker-compose.yml + .env de cada cliente
  backups/             # banco + mídias por cliente, 14 dias
```

## Primeira vez numa VPS nova
1. `infra/setup-server.sh` (como root): atualizações, Docker, firewall, fail2ban, SSH só por chave.
2. `git clone <repo> /opt/chatpipe/src`
3. `cp -r /opt/chatpipe/src/infra/stack/* /opt/chatpipe/stack/` e criar
   `/opt/chatpipe/stack/.env` com `POSTGRES_PASSWORD=<openssl rand -hex 24>`.
4. `cd /opt/chatpipe/stack && docker compose up -d`
5. `/opt/chatpipe/src/infra/bin/build-imagem.sh`
6. Cron: `0 3 * * * /opt/chatpipe/src/infra/bin/backup.sh >> /var/log/chatpipe-backup.log 2>&1`

DNS (uma vez): `chatpipe.com.br` e `*.chatpipe.com.br` → IP da VPS.

## Dia a dia
- Novo cliente: `infra/bin/novo-cliente.sh <slug> "<Nome do admin>" <email>`
- Publicar versão nova em todos: `infra/bin/atualizar-todos.sh`
- Backup manual: `infra/bin/backup.sh`

Depois de criar o cliente, preencher no `.env` dele as credenciais do WhatsApp
(app Meta da empresa do cliente) e rodar `docker compose up -d` na pasta dele.
