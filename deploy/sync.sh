#!/usr/bin/env bash
# Envia o projeto do Mac para o servidor. Rodar NO MAC, da raiz do projeto:
#   deploy/sync.sh                  # só o código
#   deploy/sync.sh --com-dados      # código + tarefas/followups/token do Google
#
# A sessão do WhatsApp (.wwebjs_auth) NUNCA é copiada: ela carrega o perfil do
# Chromium do Mac (1 GB, binário de outra plataforma). No servidor se escaneia
# um QR novo, e o WhatsApp passa a ter dois aparelhos conectados.
set -euo pipefail

SERVIDOR="${SERVIDOR:-oracle-bot}"   # host definido no ~/.ssh/config
DESTINO="${DESTINO:-~/agenda-whatsapp}"

cd "$(dirname "$0")/.."

COM_DADOS=0
[ "${1:-}" = "--com-dados" ] && COM_DADOS=1

echo "==> Enviando código para ${SERVIDOR}:${DESTINO}"
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.wwebjs_auth' \
  --exclude '.wwebjs_cache' \
  --exclude 'qr.png' \
  --exclude 'agenda.log' \
  --exclude '.env' \
  --exclude 'tarefas.json' \
  --exclude 'followups.json' \
  --exclude 'outbox.json' \
  --exclude 'recorrentes.json' \
  --exclude 'token.json' \
  --exclude 'credentials.json' \
  --exclude 'MELHORIAS.md' \
  ./ "${SERVIDOR}:${DESTINO}/"

if [ "$COM_DADOS" = "1" ]; then
  echo "==> Enviando dados e credenciais (uma vez, na migração)"
  # Sem --delete: nunca sobrescrever dados novos do servidor por engano.
  rsync -az \
    tarefas.json followups.json recorrentes.json credentials.json token.json \
    "${SERVIDOR}:${DESTINO}/" 2>/dev/null || true
  echo "    lembre: depois de migrar, o Mac não deve mais rodar o bot"
fi

echo "==> Reiniciando o container"
ssh "${SERVIDOR}" "cd ${DESTINO} && docker compose -f deploy/docker-compose.yml up -d --build"

echo "==> Últimas linhas do log"
ssh "${SERVIDOR}" "docker logs --tail 20 agenda-whatsapp"
