# Copiar backups pra fora da VPS

Hoje os backups ficam só em `/root/backups/whatsapp-crm/` na própria VPS — se a VPS
tiver um problema sério (disco corrompido, perda de acesso, etc.), os backups vão
junto. Vale ter uma cópia fora dali.

## Opção simples: rclone + Google Drive (ou qualquer storage que você já tenha)

1. Instalar o `rclone` na VPS: `curl https://rclone.org/install.sh | sudo bash`
2. Configurar uma vez: `rclone config` (cria uma conexão com Google Drive, Dropbox,
   S3, Backblaze B2 — o que for mais barato/conveniente pra você; Backblaze B2 é
   barato e simples pra esse volume pequeno de dados)
3. Adicionar ao fim do `scripts/backup.sh` (depois da linha que apaga os antigos):
   ```bash
   rclone copy "$BACKUP_DIR" remote:tractom-backups/whatsapp-crm --include "*.sql.gz" --min-age 1m
   ```
   (`--min-age 1m` evita subir o arquivo do backup rodando nesse exato minuto antes
   de terminar de escrever)

Isso mantém os últimos 14 dias localmente (pra restore rápido) e uma cópia crescente
fora da VPS (defina sua própria retenção no storage de destino, se quiser limitar).

## Alternativa ainda mais simples, sem instalar nada

Puxar o backup mais recente pro seu computador manualmente de vez em quando:
```bash
scp root@2.25.198.220:/root/backups/whatsapp-crm/whatsapp_crm-*.sql.gz ~/backups-crm-whatsapp/
```
Funciona, mas depende de alguém lembrar de rodar — não é automático. Útil como
complemento, não como única estratégia.

**Recomendação:** rclone + B2 ou Google Drive, é configurar uma vez e esquecer.
