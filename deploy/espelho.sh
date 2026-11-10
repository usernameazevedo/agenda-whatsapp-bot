#!/usr/bin/env bash
# Espelho do Mac no servidor, para a ponte `claude:` responder com o Mac
# desligado. Roda NO MAC (LaunchAgent a cada 10 min, ou na mão):
#   deploy/espelho.sh
#
# O que vai: documentos e textos de ~/claude e ~/Documents/Clientes (md, docx,
# pdf, xlsx, json, vtt, scripts...), nunca vídeo, foto ou arte-fonte; mais o
# ~/.claude do Claude (CLAUDE.md, skills, rules, agents e a memória de cada
# projeto), que é o que o claude-sync já versiona. Segredos ficam de fora.
#
# O servidor só LÊ o espelho (montado :ro no container). O único escritor é
# este script, então o --delete é seguro: o que sumir no Mac some lá.
# As sessões que o claude do servidor grava em .claude-bot/projects/*/ não
# batem no filtro de memória e por isso não são apagadas.
set -uo pipefail

SERVIDOR="${SERVIDOR:-oracle-bot}"
LOG="$HOME/claude/agenda-whatsapp/deploy/espelho.log"
LOCK="$HOME/claude/agenda-whatsapp/deploy/.espelho.lock"

log() { echo "$(date '+%F %T') $*" >>"$LOG"; }

# Uma rodada por vez (a primeira demora; as seguintes são incrementais).
if ! mkdir "$LOCK" 2>/dev/null; then exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Sem rede ou servidor fora: sai quieto, a próxima rodada tenta de novo.
if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$SERVIDOR" 'mkdir -p espelho/claude espelho/Documents/Clientes .claude-bot/projects' 2>>"$LOG"; then
  log "servidor inalcançável, pulando"
  exit 0
fi

# Ordem importa: o rsync usa a primeira regra que casar.
EXCLUI=(
  --exclude='node_modules' --exclude='.git' --exclude='.venv' --exclude='venv'
  --exclude='__pycache__' --exclude='.baileys_auth' --exclude='.wwebjs_auth'
  --exclude='credentials.json' --exclude='token.json' --exclude='.env' --exclude='.env.*'
  --exclude='*.bak-*' --exclude='whisper-models' --exclude='_docs' --exclude='.DS_Store'
)
SO_DOCUMENTOS=(
  --include='*/'
  # Symlink de atalho que a ponte usa (Documentos-NOXX → NOXX/Documentos-NOXX):
  # não é pasta nem documento, então o filtro abaixo o derrubaria. O alvo
  # está no espelho e o caminho absoluto é o mesmo dentro do container.
  --include='/Documentos-NOXX'
  --include='*.md' --include='*.txt' --include='*.json' --include='*.csv'
  --include='*.docx' --include='*.doc' --include='*.pdf' --include='*.xlsx' --include='*.pptx'
  --include='*.html' --include='*.vtt' --include='*.srt'
  --include='*.js' --include='*.py' --include='*.sh' --include='*.yml' --include='*.yaml'
  --exclude='*'
)

inicio=$(date +%s)
rsync -az --delete --prune-empty-dirs "${EXCLUI[@]}" "${SO_DOCUMENTOS[@]}" \
  "$HOME/claude/" "$SERVIDOR:espelho/claude/" 2>>"$LOG"
# ~/Documents é protegido pelo macOS: rodando pelo launchd, o rsync só entra
# se /bin/zsh tiver "Acesso Total ao Disco" (Ajustes → Privacidade e
# Segurança). Sem isso a cópia de Clientes para na última rodada manual.
if ! rsync -az --delete --prune-empty-dirs "${EXCLUI[@]}" "${SO_DOCUMENTOS[@]}" \
  "$HOME/Documents/Clientes/" "$SERVIDOR:espelho/Documents/Clientes/" 2>>"$LOG"; then
  log "Clientes não sincronizou: dê Acesso Total ao Disco a /bin/zsh (Ajustes → Privacidade e Segurança)"
fi

# ~/.claude: o que o claude-sync versiona. Sessões do servidor ficam intactas.
rsync -az "$HOME/.claude/CLAUDE.md" "$SERVIDOR:.claude-bot/CLAUDE.md" 2>>"$LOG"
for d in skills rules agents; do
  rsync -az --delete --exclude='.git' "$HOME/.claude/$d/" "$SERVIDOR:.claude-bot/$d/" 2>>"$LOG"
done
rsync -az --delete --prune-empty-dirs --include='*/' --include='memory/***' --exclude='*' \
  "$HOME/.claude/projects/" "$SERVIDOR:.claude-bot/projects/" 2>>"$LOG"

# Marca de data que a ponte põe no system prompt ("espelho de tal hora").
ssh -o BatchMode=yes "$SERVIDOR" "date '+%d/%m/%Y %H:%M' > espelho/claude/.espelho-sincronizado"
log "ok em $(( $(date +%s) - inicio ))s"
