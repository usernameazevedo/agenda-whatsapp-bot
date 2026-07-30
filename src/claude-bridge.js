// Ponte WhatsApp → Claude Code headless.
// "claude: <pedido>"  → roda `claude -p` (só leitura) e devolve a resposta no chat.
// "relatorio <user>"  → roda o pipeline de dados do instagram-analytics-noxx.
// Restrito ao dono (origem 'self'); uma execução por vez.
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from './config.js';
import { rodarShell, NO_MAC, macDisponivel } from './exec.js';

// No servidor, os caminhos são os do Mac (os comandos viajam por SSH).
const HOME = NO_MAC ? os.homedir() : (CONFIG.macHome ?? '/Users/luisazvedo');
const DIR_CLAUDE = path.join(HOME, 'claude');
const DIR_INSTAGRAM = path.join(HOME, 'claude', 'instagram-analytics-noxx');

const TIMEOUT_CLAUDE_MS = 5 * 60 * 1000;
const TIMEOUT_RELATORIO_MS = 15 * 60 * 1000;
const MAX_RESPOSTA = 3500; // margem sob o limite de mensagem do WhatsApp
const MODELO = process.env.CLAUDE_BRIDGE_MODEL || 'sonnet';
// somente ferramentas de leitura: nada de escrita/execução disparada por mensagem
const FERRAMENTAS = 'Read,Glob,Grep,WebSearch,WebFetch';

let ocupado = false;

// Tudo aqui depende da máquina do Luis (CLI claude, Documentos-NOXX,
// instagram-analytics-noxx): local no Mac, por SSH quando o bot está no servidor.
const rodarNoMac = (comando, opcoes) => rodarShell(comando, { ...opcoes, precisaMac: true });

function truncar(texto) {
  if (texto.length <= MAX_RESPOSTA) return texto;
  return `${texto.slice(0, MAX_RESPOSTA)}\n\n[resposta cortada em ${MAX_RESPOSTA} caracteres]`;
}

async function pedidoClaude(pedido) {
  // prompt vai por variável de ambiente para evitar problemas de escape no shell
  const { ok, saida } = await rodarNoMac(
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
  const { ok, saida } = await rodarNoMac(
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

// ─── item 3: briefing matinal inteligente ────────────────────────────────────
// Recebe o contexto do dia (agenda + tarefas + followups) e devolve uma análise
// curta com prioridades. Usado pelo cron do index.js; retorna null em falha.
export async function gerarBriefing(contexto) {
  const pedido =
    'Analise o dia a seguir e escreva um briefing de no máximo 8 linhas para WhatsApp: ' +
    'priorize o que é mais importante, aponte tarefas postergadas repetidamente, conflitos ou dias sobrecarregados, ' +
    'e termine com uma sugestão prática. Sem markdown, sem saudação.\n\n' + contexto;
  const { ok, saida } = await rodarNoMac(
    'claude -p "$BRIDGE_PROMPT" --model haiku < /dev/null',
    { cwd: DIR_CLAUDE, timeoutMs: TIMEOUT_CLAUDE_MS, env: { BRIDGE_PROMPT: pedido } },
  );
  return ok && saida ? `🧠 Briefing NOXX:\n${truncar(saida)}` : null;
}

// ─── item 4: caixa de ideias por cliente ─────────────────────────────────────
const DIR_NOXX = path.join(HOME, 'claude', 'Documentos-NOXX');
const PASTAS_IGNORADAS = new Set(['DOC', 'Propostas', 'README.md']);

// No Mac lê o disco direto; no servidor pergunta ao Mac por SSH.
async function listarClientes() {
  if (NO_MAC) {
    return fsSync.readdirSync(DIR_NOXX, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !PASTAS_IGNORADAS.has(d.name))
      .map((d) => d.name);
  }
  const { saida } = await rodarNoMac(`ls -1 '${DIR_NOXX}'`, { timeoutMs: 30000 });
  return saida.split('\n').map((l) => l.trim()).filter((l) => l && !PASTAS_IGNORADAS.has(l));
}

async function classificarCliente(textoIdeia, clientes) {
  const pedido =
    `Clientes: ${clientes.join(' | ')}\nIdeia: "${textoIdeia}"\n` +
    'Responda SOMENTE com o nome exato de um cliente da lista, ou "nenhum".';
  const { saida } = await rodarNoMac(
    'claude -p "$BRIDGE_PROMPT" --model haiku < /dev/null',
    { cwd: DIR_CLAUDE, timeoutMs: 60 * 1000, env: { BRIDGE_PROMPT: pedido } },
  );
  const nome = saida.trim().split('\n').pop().trim();
  return clientes.find((c) => c.toLowerCase() === nome.toLowerCase()) ?? null;
}

async function guardarIdeia(textoIdeia) {
  const clientes = await listarClientes();
  if (clientes.length === 0) {
    return '🤔 Não consegui ler a lista de clientes em Documentos-NOXX (o Mac está acessível?).';
  }
  const cliente = await classificarCliente(textoIdeia, clientes);
  if (!cliente) {
    return `🤔 Não identifiquei o cliente da ideia. Clientes atuais: ${clientes.join(', ')}. Reenvie citando o nome.`;
  }
  const arquivo = path.join(DIR_NOXX, cliente, 'ideias.md');
  const dia = new Date().toLocaleDateString('pt-BR');
  const linha = `- **${dia}** — ${textoIdeia.trim().replace(/\n+/g, ' ')}\n`;

  if (NO_MAC) {
    if (!fsSync.existsSync(arquivo)) fsSync.writeFileSync(arquivo, `# Ideias — ${cliente}\n\n`);
    fsSync.appendFileSync(arquivo, linha);
    return `💡 Ideia guardada em ${cliente}/ideias.md`;
  }

  // O texto viaja por variável para não ser interpretado pelo shell remoto.
  const { ok, saida } = await rodarNoMac(
    `[ -f '${arquivo}' ] || printf '# Ideias — %s\\n\\n' "$IDEIA_CLIENTE" > '${arquivo}'; ` +
      `printf '%s' "$IDEIA_LINHA" >> '${arquivo}'`,
    { timeoutMs: 30000, env: { IDEIA_CLIENTE: cliente, IDEIA_LINHA: linha } },
  );
  return ok
    ? `💡 Ideia guardada em ${cliente}/ideias.md`
    : `⚠️ Falha ao guardar a ideia no Mac: ${saida.slice(0, 200)}`;
}

// Detecta se a mensagem é para a ponte. Retorna null ou { aviso, rodar }.
export function interceptarBridge(texto, origem) {
  if (origem !== 'self') return null; // só o dono aciona Claude/relatórios
  const msg = texto.trim();

  const mClaude = msg.match(/^claude[:,]\s*(.+)$/is);
  const mRel = msg.match(/^relat[oó]rio\s+@?([\w.]+)\s*(?:"([^"]+)"|(.+))?$/i);
  const mIdeia = msg.match(/^ideia[:,]?\s+(.+)$/is);
  if (!mClaude && !mRel && !mIdeia) return null;

  if (!macDisponivel) {
    return {
      aviso: '🔌 Esse comando roda no Mac (Claude Code, Documentos-NOXX) e o bot está no servidor sem acesso SSH. Configure MAC_SSH_HOST.',
      rodar: null,
    };
  }

  if (ocupado) {
    return { aviso: '⏳ Já existe um pedido do Claude em andamento. Tente de novo quando ele terminar.', rodar: null };
  }

  const tarefa = mClaude
    ? () => pedidoClaude(mClaude[1])
    : mRel
      ? () => gerarRelatorio(mRel[1], mRel[2] || mRel[3])
      : () => guardarIdeia(mIdeia[1]);
  const aviso = mClaude
    ? '🤖 Pedido enviado ao Claude, processando...'
    : mRel
      ? `📊 Coletando dados de @${mRel[1]} (pode levar alguns minutos)...`
      : '💡 Classificando e guardando a ideia...';

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
