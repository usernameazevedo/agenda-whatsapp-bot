#!/bin/bash
# Publica as alterações do projeto no GitHub com um comando: ./publicar.sh "mensagem"
set -e
cd "$(dirname "$0")"

MSG="${1:-chore: atualização do bot}"

# auditoria rápida: nunca subir dados sensíveis
if git ls-files | grep -qE "config\.js$|credentials\.json|token\.json|followups\.json"; then
  echo "❌ Arquivo sensível rastreado pelo git — abortando. Confira o .gitignore."
  exit 1
fi

git add -A
if git diff --cached --quiet; then
  echo "Nada novo para publicar."
  exit 0
fi

git commit -m "$MSG"
git push
echo "✅ Publicado em https://github.com/usernameazevedo/agenda-whatsapp-bot"
