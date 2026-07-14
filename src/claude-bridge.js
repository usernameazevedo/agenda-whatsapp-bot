// Ponte WhatsApp → Claude Code headless.
// "claude: <pedido>"  → roda `claude -p` (só leitura) e devolve a resposta no chat.
// "relatorio <user>"  → roda o pipeline de dados do instagram-analytics-noxx.
// Restrito ao dono (origem 'self'); uma execução por vez.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const DIR_CLAUDE = path.join(HOME, 'claude');
const DIR_INSTAGRAM = path.join(HOME, 'claude', 'instagram-analytics-noxx');

const TIMEOUT_CLAUDE_MS = 5 * 60 * 1000;
const TIMEOUT_RELATORIO_MS = 15 * 60 * 1000;
const MAX_RESPOSTA = 3500; // margem sob o limite de mensagem do WhatsApp
const MODELO = process.env.CLAUDE_BRIDGE_MODEL || 'sonnet';
// somente ferramentas de leitura: nada de escrita/execução disparada por mensagem
const FERRAMENTAS = 'Read,Glob,Grep,WebSearch,WebFetch';

let ocupado = false;

// roda um comando num shell de login completo (Chrome/CLIs travam sem ele — ver memória do projeto)
function rodarShell(comando, { cwd, timeoutMs, env = {} }) {
  return new Promise((resolve) => {
    const proc = spawn('/bin/zsh', ['-l', '-c', comando], {
      cwd,
      env: { ...process.env, ...env },
    });
    let saida = '';
    let finalizado = false;
    const concluir = (ok, extra = '') => {
      if (finalizado) return;
      finalizado = true;
      resolve({ ok, saida: (saida + extra).trim() });
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      concluir(false, `\n[tempo esgotado após ${Math.round(timeoutMs / 60000)} min]`);
    }, timeoutMs);
    proc.stdout.on('data', (d) => { saida += d; });
    proc.stderr.on('data', (d) => { saida += d; });
    proc.on('error', (err) => { clearTimeout(timer); concluir(false, `\n${err.message}`); });
    proc.on('close', (code) => { clearTimeout(timer); concluir(code === 0); });
  });
}

function truncar(texto) {
  if (texto.length <= MAX_RESPOSTA) return texto;
  return `${texto.slice(0, MAX_RESPOSTA)}\n\n[resposta cortada em ${MAX_RESPOSTA} caracteres]`;
}

async function pedidoClaude(pedido) {
  // prompt vai por variável de ambiente para evitar problemas de escape no shell
  const { ok, saida } = await rodarShell(
    `claude -p "$BRIDGE_PROMPT" --model "$BRIDGE_MODEL" --allowedTools "${FERRAMENTAS}" ` +
      `--append-system-prompt "Você está em ${DIR_CLAUDE} (projetos do Luis em subpastas). Responda em português, curto, para leitura no WhatsApp (sem markdown pesado)." ` +
      '< /dev/null',
    { cwd: DIR_CLAUDE, timeoutMs: TIMEOUT_CLAUDE_MS, env: { BRIDGE_PROMPT: pedido, BRIDGE_MODEL: MODELO } },
  );
  if (!ok && !saida) return '🤖 O Claude não retornou resposta (veja os logs do bot).';
  return `🤖 ${truncar(saida)}`;
}

async function gerarRelatorio(username, nomeCliente) {
  const nome = nomeCliente || username;
  const { ok, saida } = await rodarShell(
    './gerar_relatorio.sh "$REL_USER" "$REL_NOME" < /dev/null',
    { cwd: DIR_INSTAGRAM, timeoutMs: TIMEOUT_RELATORIO_MS, env: { REL_USER: username, REL_NOME: nome } },
  );
  const cauda = saida.split('\n').slice(-15).join('\n');
  if (!ok) {
    const dicaToken = /token|OAuth|190|expira/i.test(saida)
      ? '\n\n⚠️ Parece problema de token da Meta: rode `python3 scr/renovar_token.py` no projeto.'
      : '';
    return `📊 Falha ao coletar dados de @${username}:\n${truncar(cauda)}${dicaToken}`;
  }
  return `📊 Dados de @${username} coletados com sucesso.\n\n${truncar(cauda)}\n\nPróximo passo: gerar o deck com a skill /noxx-relatorio-instagram no Claude.`;
}

// Detecta se a mensagem é para a ponte. Retorna null ou { aviso, rodar }.
export function interceptarBridge(texto, origem) {
  if (origem !== 'self') return null; // só o dono aciona Claude/relatórios
  const msg = texto.trim();

  const mClaude = msg.match(/^claude[:,]\s*(.+)$/is);
  const mRel = msg.match(/^relat[oó]rio\s+@?([\w.]+)\s*(?:"([^"]+)"|(.+))?$/i);
  if (!mClaude && !mRel) return null;

  if (ocupado) {
    return { aviso: '⏳ Já existe um pedido do Claude em andamento. Tente de novo quando ele terminar.', rodar: null };
  }

  const tarefa = mClaude
    ? () => pedidoClaude(mClaude[1])
    : () => gerarRelatorio(mRel[1], mRel[2] || mRel[3]);
  const aviso = mClaude
    ? '🤖 Pedido enviado ao Claude, processando...'
    : `📊 Coletando dados de @${mRel[1]} (pode levar alguns minutos)...`;

  return {
    aviso,
    rodar: async () => {
      ocupado = true;
      try {
        return await tarefa();
      } finally {
        ocupado = false;
      }
    },
  };
}
