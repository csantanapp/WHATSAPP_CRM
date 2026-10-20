#!/bin/bash
# Atualiza o código (git) e gera a imagem chatpipe-app:latest usada por todos os clientes.
set -euo pipefail
cd /opt/chatpipe/src
git pull --ff-only
docker build -t chatpipe-app:latest -t "chatpipe-app:$(git rev-parse --short HEAD)" .
echo "Imagem pronta: chatpipe-app:$(git rev-parse --short HEAD)"
