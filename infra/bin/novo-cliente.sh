#!/bin/bash
# Cria a instalação de um cliente do chatpipe:
#   novo-cliente.sh <slug> "<Nome do admin do cliente>" <email-admin-cliente>
# Ex: novo-cliente.sh iasg "Maria Silva" maria@iasg.com.br
# Resultado: https://<slug>.chatpipe.com.br com banco próprio, segredos próprios,
# super-admin da agência (suporte@tractom.com.br) e o admin do cliente.
set -euo pipefail

SLUG="${1:-}"; ADMIN_NAME="${2:-}"; ADMIN_EMAIL="${3:-}"
AGENCY_EMAIL="${AGENCY_EMAIL:-suporte@tractom.com.br}"
DOMAIN="${CHATPIPE_DOMAIN:-chatpipe.com.br}"
ROOT=/opt/chatpipe

if ! [[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{1,29}$ ]] || [ -z "$ADMIN_NAME" ] || [ -z "$ADMIN_EMAIL" ]; then
  echo "Uso: $0 <slug: letras minúsculas/números/hífen> \"<Nome do admin>\" <email-admin>" >&2; exit 1
fi
DIR="$ROOT/clientes/$SLUG"
if [ -e "$DIR" ]; then echo "Cliente $SLUG já existe em $DIR" >&2; exit 1; fi
docker image inspect chatpipe-app:latest >/dev/null 2>&1 || { echo "Gere a imagem antes: build-imagem.sh" >&2; exit 1; }

DB="chatpipe_${SLUG//-/_}"; ROLE="$DB"
rnd() { openssl rand -hex "$1"; }
DB_PASS="$(rnd 24)"
AGENCY_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
CLIENT_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-14)"

echo "== banco $DB"
docker exec -i chatpipe-db psql -v ON_ERROR_STOP=1 -U postgres <<SQL
CREATE ROLE $ROLE LOGIN PASSWORD '$DB_PASS';
CREATE DATABASE $DB OWNER $ROLE;
REVOKE ALL ON DATABASE $DB FROM PUBLIC;
SQL

echo "== arquivos"
mkdir -p "$DIR"
sed "s/__SLUG__/$SLUG/g" "$ROOT/src/infra/cliente-modelo/docker-compose.yml" > "$DIR/docker-compose.yml"
umask 077
cat > "$DIR/.env" <<ENV
NODE_ENV=production
PORT=3000
BRAND_NAME=chatpipe
PUBLIC_URL=https://$SLUG.$DOMAIN
DATABASE_URL=postgres://$ROLE:$DB_PASS@db:5432/$DB
SESSION_SECRET=$(rnd 32)
ENCRYPTION_KEY=$(rnd 32)
MEDIA_STORAGE_PATH=/data/media
WHISPER_LOCAL_URL=http://whisper:9000
# WhatsApp do cliente (app Meta da empresa dele) — preencher na conexão.
# Enquanto o APP_SECRET for este aleatório, o webhook recusa tudo (seguro).
WHATSAPP_APP_SECRET=pendente-$(rnd 16)
WHATSAPP_VERIFY_TOKEN=$(rnd 12)
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
# Instagram (app da Tractom, depois do App Review)
INSTAGRAM_PAGE_ACCESS_TOKEN=
INSTAGRAM_PAGE_ID=
INSTAGRAM_VERIFY_TOKEN=$(rnd 12)
INSTAGRAM_APP_SECRET=
ENV

echo "== subindo a instância"
(cd "$DIR" && docker compose up -d)
sleep 3
docker exec "chatpipe-$SLUG" node src/db/migrate.js
docker exec -e ADMIN_EMAIL="$AGENCY_EMAIL" -e ADMIN_PASSWORD="$AGENCY_PASS" -e ADMIN_NAME="Suporte Tractom" "chatpipe-$SLUG" node src/db/seedAdmin.js >/dev/null
docker exec -e ADMIN_EMAIL="$ADMIN_EMAIL" -e ADMIN_PASSWORD="$CLIENT_PASS" -e ADMIN_NAME="$ADMIN_NAME" -e ADMIN_PLATFORM=false "chatpipe-$SLUG" node src/db/seedAdmin.js >/dev/null

echo "== endereço https://$SLUG.$DOMAIN"
cat > "$ROOT/stack/sites/$SLUG.caddy" <<CADDY
$SLUG.$DOMAIN {
	encode gzip
	reverse_proxy chatpipe-$SLUG:3000
}
CADDY
docker exec chatpipe-caddy caddy reload --config /etc/caddy/Caddyfile

VERIFY=$(grep ^WHATSAPP_VERIFY_TOKEN "$DIR/.env" | cut -d= -f2)
cat <<INFO

Cliente $SLUG criado.
  Endereço:        https://$SLUG.$DOMAIN
  Agência:         $AGENCY_EMAIL  /  $AGENCY_PASS
  Admin cliente:   $ADMIN_EMAIL  /  $CLIENT_PASS   (pedir para trocar no 1º acesso)
  Webhook Meta:    https://$SLUG.$DOMAIN/webhook/whatsapp   (token de verificação: $VERIFY)
Guarde as senhas agora — elas não ficam salvas em texto em lugar nenhum.
INFO
