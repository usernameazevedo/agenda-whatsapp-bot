#!/usr/bin/env bash
# Envia o projeto do Mac para o servidor. Rodar NO MAC, da raiz do projeto:
#   deploy/sync.sh                  # só o código
#   deploy/sync.sh --com-dados      # código + tarefas/followups/token do Google
#
# A sessão do WhatsApp (.baileys_auth) NUNCA é copiada. Não é questão de
# tamanho: são credenciais de UM aparelho linkado, e o Baileys rotaciona as
# chaves. Duas máquinas usando a mesma sessão derrubam uma à outra com
# "Stream Errored (conflict)" e podem invalidar a sessão do Mac junto. No
# servidor se escaneia um QR novo, e o WhatsApp passa a ter dois aparelhos.
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
  --exclude '.baileys_auth' \
  --exclude 'downtime.json' \
  --exclude 'execucoes.json' \
  --exclude 'my-repo.json' \
  --exclude 'alertas-oracle.json' \
  --exclude 'qr.png' \
  --exclude 'envios' \
  --exclude '*.bak-*' \
  --exclude 'agenda.log' \
  --exclude '.env' \
  --exclude 'tarefas.json' \
  --exclude 'followups.json' \
  --exclude 'outbox.json' \
  --exclude 'bridge-sessao.json' \
  --exclude 'deploy/espelho.log' \
  --exclude 'recorrentes.json' \
  --exclude 'token.json' \
  --exclude 'credentials.json' \
  --exclude 'MELHORIAS.md' \
  --exclude 'deploy/oracle-launch-retry.log' \
  --exclude 'deploy/.oracle-instance' \
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
# BOT_UID/BOT_GID vêm do próprio servidor: o container roda com o uid do dono
# dos arquivos montados. Sem isso, host cujo usuário não é 1000 (o Ubuntu da
# Oracle usa 1001) derruba o bot em EACCES ao gravar a sessão do WhatsApp.
ssh "${SERVIDOR}" "cd ${DESTINO} && BOT_UID=\$(id -u) BOT_GID=\$(id -g) docker compose -f deploy/docker-compose.yml up -d --build"

echo "==> Últimas linhas do log"
ssh "${SERVIDOR}" "docker logs --tail 20 agenda-whatsapp"
