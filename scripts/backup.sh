#!/bin/bash
# Backup diário do banco do CRM WhatsApp (whatsapp_crm), comprimido, com
# retenção de 14 dias. Rodado via cron — ver crontab do root na VPS.
set -euo pipefail

BACKUP_DIR="/root/backups/whatsapp-crm"
RETENTION_DAYS=14
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$BACKUP_DIR/whatsapp_crm-$TIMESTAMP.sql.gz"

mkdir -p "$BACKUP_DIR"

if docker exec whatsapp-crm-db pg_dump -U postgres whatsapp_crm | gzip > "$FILE"; then
  echo "[$(date -Is)] backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
else
  echo "[$(date -Is)] FALHA no backup de whatsapp_crm" >&2
  rm -f "$FILE"
  exit 1
fi

# Retenção: apaga backups diários com mais de 14 dias (não mexe nos backups
# manuais de marco de fase, como pre-fase0-*.sql, que não seguem esse padrão de nome).
find "$BACKUP_DIR" -maxdepth 1 -name 'whatsapp_crm-*.sql.gz' -mtime +"$RETENTION_DAYS" -print -delete
