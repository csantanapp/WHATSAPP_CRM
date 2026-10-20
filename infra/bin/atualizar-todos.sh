#!/bin/bash
# Publica a versão nova em TODOS os clientes: gera a imagem, faz backup de
# cada banco, recria cada instância e roda as migrações. Para no 1º erro.
set -euo pipefail
ROOT=/opt/chatpipe
"$ROOT/src/infra/bin/build-imagem.sh"
"$ROOT/src/infra/bin/backup.sh"
for dir in "$ROOT"/clientes/*/; do
  slug=$(basename "$dir")
  echo "== $slug"
  (cd "$dir" && docker compose up -d --force-recreate)
  sleep 3
  docker exec "chatpipe-$slug" node src/db/migrate.js | tail -1
  host="$slug.${CHATPIPE_DOMAIN:-chatpipe.com.br}"
  code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$host:443:127.0.0.1" "https://$host/login.html" || true)
  echo "   resposta: $code"
done
echo "Todos atualizados."
