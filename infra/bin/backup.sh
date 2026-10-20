#!/bin/bash
# Backup de todos os clientes: banco (pg_dump) + mídias, com retenção de 14 dias.
# Rodar diariamente pelo cron: 0 3 * * * /opt/chatpipe/src/infra/bin/backup.sh >> /var/log/chatpipe-backup.log 2>&1
set -euo pipefail
ROOT=/opt/chatpipe; DEST="$ROOT/backups"; TS=$(date +%Y%m%d-%H%M%S); KEEP_DAYS=14
mkdir -p "$DEST"
for dir in "$ROOT"/clientes/*/; do
  [ -d "$dir" ] || continue
  slug=$(basename "$dir"); db="chatpipe_${slug//-/_}"
  docker exec chatpipe-db pg_dump -U postgres "$db" | gzip > "$DEST/$slug-db-$TS.sql.gz"
  docker run --rm -v "chatpipe_${slug}_media:/m:ro" -v "$DEST:/out" alpine tar czf "/out/$slug-midias-$TS.tgz" -C /m . 2>/dev/null || true
  echo "[$(date -Is)] backup ok: $slug ($(du -h "$DEST/$slug-db-$TS.sql.gz" | cut -f1))"
done
find "$DEST" -maxdepth 1 -type f -mtime +"$KEEP_DAYS" -delete
