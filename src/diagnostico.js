// Diagnóstico diário das automações do Mac (LaunchAgents do Luis + pm2).
// Se algo estiver com exit code de erro, pede um diagnóstico curto ao Claude
// e devolve a mensagem para o WhatsApp; retorna null quando está tudo bem.
//
// É inteiramente sobre o Mac: quando o bot roda no servidor, os comandos vão
// por SSH. Sem acesso ao Mac, o diagnóstico simplesmente não roda.
import { CONFIG } from './config.js';
import { rodarShell, EH_MAC, macDisponivel } from './exec.js';

const TIMEOUT_MS = 3 * 60 * 1000;
const DIR_PROJETO = EH_MAC ? '~/claude/agenda-whatsapp' : `${CONFIG.macHome}/claude/agenda-whatsapp`;

async function rodar(comando, timeoutMs = 30000, env = {}) {
  const { saida } = await rodarShell(comando, { timeoutMs, env, precisaMac: true });
  return saida;
}

export async function diagnosticarAutomacoes() {
  if (!macDisponivel) return null;

  const lista = await rodar('launchctl list | grep -E "luisazvedo|luisazevedo" || true');
  // formato: PID\tExitCode\tLabel — problema = exit code diferente de 0
  const quebrados = lista.split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length === 3 && c[1] !== '0' && c[1] !== '-')
    .map(([pid, code, label]) => `${label} (exit ${code})`);

  if (quebrados.length === 0) return null;

  // contexto de logs conhecidos para o diagnóstico
  const logs = await rodar(
    `for f in ${DIR_PROJETO}/agenda.log ~/.pm2/logs/agenda-whatsapp-error.log /tmp/*luisazvedo*.log; do` +
    ' [ -f "$f" ] && echo "== $f ==" && tail -20 "$f"; done 2>/dev/null | tail -80',
  );

  const pedido =
    `LaunchAgents com erro no macOS: ${quebrados.join('; ')}.\n\nLogs recentes:\n${logs}\n\n` +
    'Em até 5 linhas, diga a causa provável de cada agente quebrado e o comando para investigar/corrigir. Sem markdown.';
  const diagnostico = await rodar(
    'claude -p "$DIAG_PROMPT" --model haiku < /dev/null',
    TIMEOUT_MS,
    { DIAG_PROMPT: pedido },
  );

  return `🩺 Automações com problema: ${quebrados.join('; ')}\n\n${diagnostico.trim() || 'Sem diagnóstico do Claude — verifique manualmente.'}`.slice(0, 3500);
}
