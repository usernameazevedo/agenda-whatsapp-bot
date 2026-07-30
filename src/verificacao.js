// Verificação diária (06:00): saúde do app + uma melhoria por dia.
// Coleta sinais locais (pm2, logs, filas), entrega ao Claude headless com
// leitura do código, e devolve a mensagem para o WhatsApp. As sugestões
// ficam em MELHORIAS.md para não repetir e servir de backlog.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { rodarShell, NO_MAC, ontemStr, hojeStrLocal } from './exec.js';

const RAIZ = path.resolve('.');
const MELHORIAS = path.join(RAIZ, 'MELHORIAS.md');
const TIMEOUT_MS = 6 * 60 * 1000;
const MODELO = process.env.VERIFICACAO_MODEL || 'haiku';
const MAX_MSG = 3500;

async function rodar(comando, timeoutMs = 30000, env = {}, cwd = RAIZ) {
  const { saida } = await rodarShell(comando, { cwd, timeoutMs, env });
  return saida;
}

// A análise do código roda no Claude Code, que vive no Mac — e lá o projeto
// está no clone do repositório, não no caminho do servidor.
const RAIZ_NO_MAC = NO_MAC ? RAIZ : `${CONFIG.macHome}/claude/agenda-whatsapp`;

async function rodarNoMac(comando, timeoutMs, env) {
  const { saida } = await rodarShell(comando, { cwd: RAIZ_NO_MAC, timeoutMs, env, precisaMac: true });
  return saida;
}

// No Mac o processo é gerenciado pelo pm2; no servidor, pelo Docker/systemd.
async function estadoDoProcesso() {
  if (NO_MAC) {
    return rodar('pm2 jlist 2>/dev/null | python3 -c "import json,sys; a=json.load(sys.stdin); [print(p[\'name\'], p[\'pm2_env\'][\'status\'], \'restarts=\'+str(p[\'pm2_env\'][\'restart_time\'])) for p in a]" 2>/dev/null || pm2 ls');
  }
  return rodar(
    'docker ps --filter name=agenda-whatsapp --format "{{.Names}} {{.Status}}" 2>/dev/null' +
      ' || systemctl --user is-active agenda-whatsapp 2>/dev/null || echo "(sem gerenciador detectado)"',
  );
}

// Logs: arquivos do pm2 no Mac, journal do container no servidor.
async function logs(filtro, linhas) {
  const fonte = NO_MAC
    ? 'cat ~/.pm2/logs/agenda-whatsapp-error.log ~/.pm2/logs/agenda-whatsapp-out.log 2>/dev/null'
    : 'docker logs --since 48h agenda-whatsapp 2>&1';
  return rodar(`${fonte} | grep -F "$LOG_FILTRO" | tail -${linhas}`, 30000, { LOG_FILTRO: filtro });
}

async function coletarSaude() {
  const processo = await estadoDoProcesso();
  const errosHoje = await logs(hojeStrLocal(), 10);
  const errosOntem = await logs(ontemStr(), 5);
  const naoIdentificou = await rodar(
    (NO_MAC
      ? 'cat ~/.pm2/logs/agenda-whatsapp-out.log 2>/dev/null'
      : 'docker logs --since 48h agenda-whatsapp 2>&1') + ' | grep -c "não identifiquei" || true',
  );
  const outbox = fs.existsSync(path.join(RAIZ, 'outbox.json'))
    ? fs.readFileSync(path.join(RAIZ, 'outbox.json'), 'utf8').slice(0, 300)
    : '(sem arquivo)';
  const disco = await rodar("df -h / | tail -1 | awk '{print $5\" usado\"}'");
  const memoria = NO_MAC ? '' : await rodar("free -m | awk 'NR==2{print $3\"/\"$2\" MB usados\"}'");
  return (
    `processo:\n${processo.trim()}\n\n` +
    `linhas de log (hoje):\n${errosHoje.trim() || 'nenhuma'}\n\n` +
    `linhas de log (ontem):\n${errosOntem.trim() || 'nenhuma'}\n\n` +
    `outbox pendente: ${outbox.trim()}\ndisco: ${disco.trim()}\n` +
    (memoria ? `memória: ${memoria.trim()}\n` : '') +
    `respostas "não identifiquei" (48h): ${naoIdentificou.trim() || '?'}`
  );
}

function sugestoesAnteriores() {
  try {
    return fs.readFileSync(MELHORIAS, 'utf8').split('\n').filter((l) => l.startsWith('- ')).slice(-20).join('\n');
  } catch {
    return '(nenhuma ainda)';
  }
}

function registrarSugestao(texto) {
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const linha = `- ${dia}: ${texto.replace(/\s+/g, ' ').trim()}\n`;
  fs.appendFileSync(MELHORIAS, linha);
}

export async function verificacaoDiaria() {
  const saude = await coletarSaude();
  const anteriores = sugestoesAnteriores();

  const pedido =
    `Você é o mantenedor do app agenda-whatsapp (bot WhatsApp ↔ Google Calendar deste diretório). ` +
    `Dados de saúde de agora:\n${saude}\n\n` +
    `Melhorias já sugeridas antes (NÃO repita nenhuma):\n${anteriores}\n\n` +
    `Faça duas coisas, em português, sem markdown pesado (só *negrito* e •, é WhatsApp):\n` +
    `1) SAÚDE: avalie os dados acima em até 3 linhas (diga "tudo ok" se estiver tudo ok; aponte erro/risco se houver).\n` +
    `2) MELHORIA DO DIA: leia o código-fonte em src/ e proponha UMA melhoria concreta, pequena e útil ` +
    `(funcionalidade, robustez ou UX do WhatsApp), com 1-2 frases do que é e por que vale a pena. ` +
    `Responda no total em até 12 linhas.`;

  // A CLI do Claude e o repo de trabalho ficam no Mac; quando o bot está no
  // servidor, o pedido viaja por SSH e o código analisado é o clone do Mac.
  const resposta = await rodarNoMac(
    `claude -p "$VERIF_PROMPT" --model "$VERIF_MODEL" --allowedTools "Read,Glob,Grep" < /dev/null`,
    TIMEOUT_MS,
    { VERIF_PROMPT: pedido, VERIF_MODEL: MODELO },
  );

  const texto = resposta.trim();
  if (!texto) return '🔎 Verificação das 6h: o Claude não retornou resposta (verifique os logs do bot).';

  // guarda a parte da melhoria no backlog (heurística: da palavra MELHORIA em diante)
  const idx = texto.toUpperCase().indexOf('MELHORIA');
  registrarSugestao(idx >= 0 ? texto.slice(idx) : texto);

  return `🔎 *Verificação diária (6h)*\n\n${texto}`.slice(0, MAX_MSG);
}
