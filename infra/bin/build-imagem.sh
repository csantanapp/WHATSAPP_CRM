#!/bin/bash
# Atualiza o código (git) e gera a imagem chatpipe-app:latest usada por todos os clientes.
set -euo pipefail
cd /opt/chatpipe/src
# Código chega por `git pull` (se o servidor tiver acesso ao repositório) ou
# por pacote (git bundle) enviado no deploy — nesse caso o pull é pulado.
git pull --ff-only 2>/dev/null || echo "(sem git pull — usando o código já presente: $(git log --oneline -1))"
docker build -t chatpipe-app:latest -t "chatpipe-app:$(git rev-parse --short HEAD)" .
echo "Imagem pronta: chatpipe-app:$(git rev-parse --short HEAD)"
