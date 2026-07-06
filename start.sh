#!/bin/bash
# Partida limpa do agenda-whatsapp: mata Chromes órfãos do perfil e remove locks
cd "$(dirname "$0")"

# mata instâncias antigas do Chrome usando o perfil do bot
pkill -f "wwebjs_auth" 2>/dev/null
sleep 2

# remove locks de perfil deixados por encerramento abrupto
rm -f .wwebjs_auth/session/Singleton* 2>/dev/null

exec /opt/homebrew/bin/node src/index.js
