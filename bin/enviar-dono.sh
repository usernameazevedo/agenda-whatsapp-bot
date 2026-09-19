#!/usr/bin/env bash
# Manda texto e/ou arquivo para o DONO do bot (o grupo do config), e para
# mais ninguém. É o único comando de shell que a ponte `claude:` pode rodar:
# o destinatário é fixo aqui, não depende do que o modelo escreve.
#
#   bin/enviar-dono.sh "legenda" [arquivo ...]
#
# GRUPO_DONO vem da ponte (CONFIG.grupo). Sem ela, lê o config.
set -euo pipefail
cd "$(dirname "$0")/.."

DESTINO="${GRUPO_DONO:-}"
if [ -z "$DESTINO" ]; then
  DESTINO="$(node -e "import('./src/config.js').then((m) => console.log(m.CONFIG.grupo || m.CONFIG.destinatario))")"
fi

# Dentro do container o bot é ESTE processo: o .bot-remoto que veio do Mac
# pelo sync apontaria para o próprio servidor. Vazio = local (ver enviar.js).
if [ -f /.dockerenv ]; then
  export BOT_REMOTO=""
fi

exec node bin/enviar.js "$DESTINO" "$@"
