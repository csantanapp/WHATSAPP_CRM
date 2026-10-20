#!/bin/bash
# Prepara uma VPS Ubuntu 24.04 nova para o chatpipe (rodar 1x, como root).
# - atualizações de segurança automáticas, swap, fuso
# - Docker oficial
# - firewall (só 22, 80, 443) + fail2ban no SSH
# - SSH só por chave (desliga senha) — SÓ se já existir chave em authorized_keys
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Rode como root." >&2; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

echo "== pacotes e atualizações automáticas"
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl gnupg ufw fail2ban unattended-upgrades git jq
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== swap de 2 GB (folga para builds e picos)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Docker (repositório oficial)"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
# Logs dos containers com tamanho limitado (não enchem o disco).
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
JSON
systemctl restart docker

echo "== firewall: só SSH, HTTP e HTTPS"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "== fail2ban no SSH (bloqueia quem erra a senha/chave várias vezes)"
cat > /etc/fail2ban/jail.d/sshd.local <<'INI'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
INI
systemctl enable --now fail2ban
systemctl restart fail2ban

echo "== SSH só por chave"
if [ -s /root/.ssh/authorized_keys ]; then
  mkdir -p /run/sshd
  # 01- para ganhar do 50-cloud-init.conf (no sshd vale o primeiro valor lido)
  cat > /etc/ssh/sshd_config.d/01-chatpipe.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 4
CONF
  sshd -t && systemctl reload ssh
  echo "   senha desligada; acesso só por chave."
else
  echo "   ATENÇÃO: sem chave em /root/.ssh/authorized_keys — mantive o login por senha para não te trancar fora." >&2
fi

echo "== pastas do chatpipe"
mkdir -p /opt/chatpipe/{stack,clientes,backups}
echo "Pronto. Próximo: clonar o código em /opt/chatpipe/src e subir infra/stack."
