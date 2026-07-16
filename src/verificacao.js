// Verificação diária (06:00): saúde do app + uma melhoria por dia.
// Coleta sinais locais (pm2, logs, filas), entrega ao Claude headless com
// leitura do código, e devolve a mensagem para o WhatsApp. As sugestões
// ficam em MELHORIAS.md para não repetir e servir de backlog.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const RAIZ = path.resolve('.');
const MELHORIAS = path.join(RAIZ, 'MELHORIAS.md');
const TIMEOUT_MS = 6 * 60 * 1000;
const MODELO = process.env.VERIFICACAO_MODEL || 'haiku';
const MAX_MSG = 3500;

function rodar(comando, timeoutMs = 30000, env = {}, cwd = RAIZ) {
  return new Promise((resolve) => {
    const proc = spawn('/bin/zsh', ['-l', '-c', comando], { cwd, env: { ...process.env, ...env } });
    let saida = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(saida); }, timeoutMs);
    proc.stdout.on('data', (d) => { saida += d; });
    proc.stderr.on('data', (d) => { saida += d; });
    proc.on('close', () => { clearTimeout(timer); resolve(saida); });
    proc.on('error', () => { clearTimeout(timer); resolve(saida); });
  });
}

async function coletarSaude() {
  const pm2 = await rodar('pm2 jlist 2>/dev/null | python3 -c "import json,sys; a=json.load(sys.stdin); [print(p[\'name\'], p[\'pm2_env\'][\'status\'], \'restarts=\'+str(p[\'pm2_env\'][\'restart_time\'])) for p in a]" 2>/dev/null || pm2 ls');
  const errosLog = await rodar('grep "$(date +%Y-%m-%d)\\|$(date -v-1d +%Y-%m-%d)" ~/.pm2/logs/agenda-whatsapp-error.log 2>/dev/null | tail -15');
  const atividade = await rodar('grep -c "Mensagem recebida" ~/.pm2/logs/agenda-whatsapp-out.log 2>/dev/null; grep "$(date -v-1d +%Y-%m-%dT)" ~/.pm2/logs/agenda-whatsapp-out.log 2>/dev/null | grep -c "não identifiquei"');
  const outbox = fs.existsSync(path.join(RAIZ, 'outbox.json'))
    ? fs.readFileSync(path.join(RAIZ, 'outbox.json'), 'utf8').slice(0, 300)
    : '(sem arquivo)';
  const disco = await rodar("df -h / | tail -1 | awk '{print $5\" usado\"}'");
  return `pm2:\n${pm2.trim()}\n\nerros (24-48h):\n${errosLog.trim() || 'nenhum'}\n\noutbox pendente: ${outbox.trim()}\ndisco: ${disco.trim()}\nrespostas "não identifiquei" ontem: ${atividade.split('\n')[1] ?? '?'}`;
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

  const resposta = await rodar(
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
