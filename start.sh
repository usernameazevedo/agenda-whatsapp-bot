#!/bin/bash
# Partida do agenda-whatsapp. Desde a migração para o Baileys não há navegador
# para limpar: basta subir o processo.
cd "$(dirname "$0")"
exec /opt/homebrew/bin/node src/index.js
