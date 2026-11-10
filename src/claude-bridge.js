// Ponte WhatsApp → Claude Code headless.
// "claude: <pedido>"  → roda `claude -p` aqui mesmo, lendo o espelho dos arquivos
//                      do Mac (no servidor) ou o disco (no Mac), com memória entre
//                      mensagens (--resume). "claude: nova" zera a conversa.
// "relatorio <user>"  → roda o pipeline de dados do instagram-analytics-noxx (Mac).
// "ideia: <texto>"    → guarda a ideia em <Cliente>/ideias.md (escrita: Mac).
// Restrito ao dono (origem 'self'); uma execução por vez.
//
// O cérebro nunca lê o disco do Mac por SSH: no servidor ele lê o espelho que o
// Mac empurra (deploy/espelho.sh), montado nos MESMOS caminhos absolutos do Mac,
// então nada aqui muda de máquina para máquina. Só o que precisa do hardware
// ou dos apps do Mac (relatório, escrita de ideia) continua viajando por SSH.
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from './config.js';
import { rodarShell, EH_MAC, macDisponivel, macForaDoAr } from './exec.js';
import { gerarTexto } from './ia.js';

// No servidor, os caminhos são os do Mac (o espelho é montado neles).
const HOME = EH_MAC ? os.homedir() : (CONFIG.macHome ?? '/Users/luisazvedo');
const DIR_CLAUDE = path.join(HOME, 'claude');
const DIR_INSTAGRAM = path.join(HOME, 'claude', 'instagram-analytics-noxx');
// Marca que o espelho.sh grava no fim de cada sincronização (data legível).
const MARCA_ESPELHO = path.join(DIR_CLAUDE, '.espelho-sincronizado');
// Onde fica o id da conversa em andamento (uma por vez; "nova" apaga).
const ARQ_SESSAO = new URL('../bridge-sessao.json', import.meta.url).pathname;
// Único Bash que a ponte pode rodar: manda texto/arquivo para o dono e para
// mais ninguém (o destinatário é fixo no script, não no que o modelo escreve).
const RAIZ_BOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENVIAR_DONO = path.join(RAIZ_BOT, 'bin', 'enviar-dono.sh');

const TIMEOUT_CLAUDE_MS = 5 * 60 * 1000;
const TIMEOUT_RELATORIO_MS = 15 * 60 * 1000;
const MAX_RESPOSTA = 3500; // margem sob o limite de mensagem do WhatsApp
const MODELO = process.env.CLAUDE_BRIDGE_MODEL || 'sonnet';
// Leitura, busca e web; escrita nunca. O único comando de shell é o de
// mandar arquivo ao dono (ver ENVIAR_DONO).
const FERRAMENTAS = `Read,Glob,Grep,WebSearch,WebFetch,Bash(${ENVIAR_DONO}:*)`;

let ocupado = false;

// Só o que depende da máquina do Luis (CLI do relatório, escrita em
// Documentos-NOXX): local no Mac, por SSH quando o bot está no servidor.
const rodarNoMac = (comando, opcoes) => rodarShell(comando, { ...opcoes, precisaMac: true });
const AVISO_MAC_FORA = '🔌 Mac fora do ar (desligado, dormindo ou sem rede). Tente quando ele estiver ligado.';

function truncar(texto) {
  if (texto.length <= MAX_RESPOSTA) return texto;
  return `${texto.slice(0, MAX_RESPOSTA)}\n\n[resposta cortada em ${MAX_RESPOSTA} caracteres]`;
}

// ─── memória da conversa (--resume) ──────────────────────────────────────────
function lerSessao() {
  try {
    return JSON.parse(fsSync.readFileSync(ARQ_SESSAO, 'utf8')).id || null;
  } catch {
    return null;
  }
}
function gravarSessao(id) {
  fsSync.writeFileSync(ARQ_SESSAO, JSON.stringify({ id, desde: new Date().toISOString() }, null, 1));
}
function apagarSessao() {
  try { fsSync.unlinkSync(ARQ_SESSAO); } catch {}
}

// Contexto que vai no system prompt: onde o Claude está, o que ele enxerga
// (espelho de tal hora ou disco ao vivo) e como devolver arquivo.
function contextoSistema() {
  let dados = 'Você lê o disco do Mac ao vivo.';
  if (!EH_MAC) {
    let quando = 'data desconhecida';
    try { quando = fsSync.readFileSync(MARCA_ESPELHO, 'utf8').trim(); } catch {}
    dados =
      `Você lê um ESPELHO só-leitura dos arquivos do Mac do Luis, sincronizado em ${quando} ` +
      '(documentos e textos; vídeo, foto pesada e arte-fonte não estão aqui). Se pedirem algo que não está no espelho, diga isso.';
  }
  return (
    `Você está em ${DIR_CLAUDE} (projetos do Luis em subpastas; clientes em ${path.join(HOME, 'Documents', 'Clientes')}). ${dados} ` +
    `Para mandar um arquivo ao Luis no WhatsApp, rode: ${ENVIAR_DONO} "legenda curta" /caminho/do/arquivo (um ou mais arquivos). ` +
    'A legenda é só o nome do que vai; a resposta à pergunta vai no seu texto final, sempre. ' +
    'Responda em português, curto, para leitura no WhatsApp (sem markdown pesado, sem tabelas).'
  );
}

// Roda o `claude -p` uma vez; devolve { ok, texto, sessao }.
async function rodarClaude(pedido, sessao) {
  const resume = sessao ? `--resume "$BRIDGE_SESSAO" ` : '';
  const { ok, saida } = await rodarShell(
    `claude -p "$BRIDGE_PROMPT" --model "$BRIDGE_MODEL" --output-format json ${resume}` +
      `--allowedTools "${FERRAMENTAS}" --append-system-prompt "$BRIDGE_SISTEMA" < /dev/null`,
    {
      cwd: DIR_CLAUDE,
      timeoutMs: TIMEOUT_CLAUDE_MS,
      env: {
        BRIDGE_PROMPT: pedido,
        BRIDGE_MODEL: MODELO,
        BRIDGE_SISTEMA: contextoSistema(),
        BRIDGE_SESSAO: sessao ?? '',
        GRUPO_DONO: CONFIG.grupo ?? '',
      },
    },
  );
  // Com --output-format json a última linha é o resultado; antes dela pode vir
  // ruído de stderr (avisos do CLI), que o rodarShell mistura na saída.
  const linhaJson = saida.split('\n').reverse().find((l) => l.trim().startsWith('{'));
  let r = null;
  try { r = JSON.parse(linhaJson); } catch {}
  if (!r) return { ok: false, texto: saida, sessao: null };
  return { ok: ok && !r.is_error, texto: r.result ?? saida, sessao: r.session_id ?? null };
}

async function pedidoClaude(pedido) {
  if (/^nova\s*$/i.test(pedido.trim())) {
    apagarSessao();
    return '🧠 Conversa nova. O próximo pedido começa do zero.';
  }
  let sessao = lerSessao();
  let r = await rodarClaude(pedido, sessao);
  // Sessão sumiu (volume recriado, CLI atualizado): recomeça sem ela, uma vez.
  if (!r.ok && sessao && /session|conversation/i.test(r.texto)) {
    apagarSessao();
    sessao = null;
    r = await rodarClaude(pedido, null);
  }
  if (r.sessao && r.sessao !== sessao) gravarSessao(r.sessao);
  if (!r.ok) return `🤖 O Claude não conseguiu responder: ${truncar(r.texto || 'sem saída (veja os logs do bot)')}`;
  return `🤖 ${truncar(r.texto)}`;
}

async function gerarRelatorio(username, nomeCliente) {
  const nome = nomeCliente || username;
  const r = await rodarNoMac(
    './gerar_relatorio.sh "$REL_USER" "$REL_NOME" < /dev/null',
    { cwd: DIR_INSTAGRAM, timeoutMs: TIMEOUT_RELATORIO_MS, env: { REL_USER: username, REL_NOME: nome } },
  );
  if (macForaDoAr(r)) return AVISO_MAC_FORA;
  const { ok, saida } = r;
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
// É chamada pura de API (sem ferramentas), então roda onde o bot estiver.
export async function gerarBriefing(contexto) {
  const pedido =
    'Analise o dia a seguir e escreva um briefing de no máximo 8 linhas para WhatsApp: ' +
    'priorize o que é mais importante, aponte tarefas postergadas repetidamente, conflitos ou dias sobrecarregados, ' +
    'e termine com uma sugestão prática. Sem markdown, sem saudação.\n\n' + contexto;
  try {
    const saida = await gerarTexto(pedido);
    return saida ? `🧠 Briefing NOXX:\n${truncar(saida.trim())}` : null;
  } catch (err) {
    console.error('briefing:', err.message);
    return null;
  }
}

// ─── item 4: caixa de ideias por cliente ─────────────────────────────────────
const DIR_NOXX = path.join(HOME, 'claude', 'Documentos-NOXX');
const PASTAS_IGNORADAS = new Set(['DOC', 'Propostas', 'README.md']);

// Lê a pasta no disco (Mac) ou no espelho (servidor); SSH só se não houver espelho.
async function listarClientes() {
  if (fsSync.existsSync(DIR_NOXX)) {
    return fsSync.readdirSync(DIR_NOXX, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !PASTAS_IGNORADAS.has(d.name))
      .map((d) => d.name);
  }
  const r = await rodarNoMac(`ls -1 '${DIR_NOXX}'`, { timeoutMs: 30000 });
  if (macForaDoAr(r)) return [];
  return r.saida.split('\n').map((l) => l.trim()).filter((l) => l && !PASTAS_IGNORADAS.has(l));
}

// Chamada pura de API: não precisa do Mac.
async function classificarCliente(textoIdeia, clientes) {
  const pedido =
    `Clientes: ${clientes.join(' | ')}\nIdeia: "${textoIdeia}"\n` +
    'Responda SOMENTE com o nome exato de um cliente da lista, ou "nenhum".';
  const saida = (await gerarTexto(pedido)) ?? '';
  const nome = saida.trim().split('\n').pop().trim();
  return clientes.find((c) => c.toLowerCase() === nome.toLowerCase()) ?? null;
}

async function guardarIdeia(textoIdeia) {
  const clientes = await listarClientes();
  if (clientes.length === 0) {
    return `🤔 Não consegui ler a lista de clientes em Documentos-NOXX. ${macDisponivel ? AVISO_MAC_FORA : 'Sem espelho nem MAC_SSH_HOST.'}`;
  }
  const cliente = await classificarCliente(textoIdeia, clientes);
  if (!cliente) {
    return `🤔 Não identifiquei o cliente da ideia. Clientes atuais: ${clientes.join(', ')}. Reenvie citando o nome.`;
  }
  const arquivo = path.join(DIR_NOXX, cliente, 'ideias.md');
  const dia = new Date().toLocaleDateString('pt-BR');
  const linha = `- **${dia}** — ${textoIdeia.trim().replace(/\n+/g, ' ')}\n`;

  if (EH_MAC) {
    if (!fsSync.existsSync(arquivo)) fsSync.writeFileSync(arquivo, `# Ideias — ${cliente}\n\n`);
    fsSync.appendFileSync(arquivo, linha);
    return `💡 Ideia guardada em ${cliente}/ideias.md`;
  }

  // O texto viaja por variável para não ser interpretado pelo shell remoto.
  const r = await rodarNoMac(
    `[ -f '${arquivo}' ] || printf '# Ideias — %s\\n\\n' "$IDEIA_CLIENTE" > '${arquivo}'; ` +
      `printf '%s' "$IDEIA_LINHA" >> '${arquivo}'`,
    { timeoutMs: 30000, env: { IDEIA_CLIENTE: cliente, IDEIA_LINHA: linha } },
  );
  if (macForaDoAr(r)) return AVISO_MAC_FORA;
  const { ok, saida } = r;
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

  // `claude:` roda aqui (espelho). Relatório e ideia precisam do Mac de verdade.
  if (!mClaude && !macDisponivel) {
    return {
      aviso: '🔌 Esse comando roda no Mac (relatório do Instagram, escrita em Documentos-NOXX) e o bot está no servidor sem MAC_SSH_HOST.',
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
