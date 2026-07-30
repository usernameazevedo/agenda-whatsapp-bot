// Execução de comandos de shell, portável entre o Mac e o servidor Linux.
//
// No macOS o shell precisa ser de login (`zsh -l`): sem ele o Chrome e as CLIs
// travam sem erro (ver memória do projeto). No Linux do servidor usamos
// `bash -l`.
//
// Alguns comandos só existem na máquina do Luis (CLI `claude`, pastas de
// Documentos-NOXX, launchctl). Quando o bot roda no servidor, esses comandos
// são reenviados por SSH para o Mac — assim o processamento pesado continua
// sob demanda, e não 24h por dia.
import { spawn } from 'node:child_process';
import { CONFIG } from './config.js';

export const NO_MAC = process.platform === 'darwin';

const SHELL = NO_MAC ? '/bin/zsh' : '/bin/bash';

// Comandos que dependem da máquina do Luis podem rodar remotamente.
export const macRemotoDisponivel = !NO_MAC && Boolean(CONFIG.macSshHost);
export const macDisponivel = NO_MAC || macRemotoDisponivel;

// Monta o comando final: local, ou embrulhado em ssh quando precisa do Mac.
function montarComando(comando, { precisaMac, cwd, env }) {
  if (!precisaMac || NO_MAC) return { comando, spawnCwd: cwd, spawnEnv: env };

  // As variáveis viajam no próprio comando remoto (o sshd não repassa env por
  // padrão); o valor vai em single quotes escapadas para não quebrar o shell.
  const exports = Object.entries(env)
    .map(([chave, valor]) => `export ${chave}='${String(valor).replace(/'/g, `'\\''`)}'`)
    .join('; ');
  const remoto = [cwd ? `cd '${cwd}'` : '', exports, comando].filter(Boolean).join('; ');
  return {
    comando: `ssh -o BatchMode=yes -o ConnectTimeout=15 ${CONFIG.macSshHost} ${JSON.stringify(remoto)}`,
    spawnCwd: undefined,
    spawnEnv: {},
  };
}

/**
 * Roda um comando e devolve { ok, saida } — nunca rejeita.
 * @param {string} comando
 * @param {{ cwd?: string, timeoutMs?: number, env?: Record<string,string>, precisaMac?: boolean }} opcoes
 * @returns {Promise<{ ok: boolean, saida: string }>}
 */
export function rodarShell(comando, opcoes = {}) {
  const { cwd, timeoutMs = 30000, env = {}, precisaMac = false } = opcoes;

  if (precisaMac && !macDisponivel) {
    return Promise.resolve({
      ok: false,
      saida: 'Este comando depende do Mac e o bot está no servidor sem MAC_SSH_HOST configurado.',
    });
  }

  const alvo = montarComando(comando, { precisaMac, cwd, env });

  return new Promise((resolve) => {
    const proc = spawn(SHELL, ['-l', '-c', alvo.comando], {
      cwd: alvo.spawnCwd,
      env: { ...process.env, ...alvo.spawnEnv },
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

// Data de ontem no formato YYYY-MM-DD: `date -v-1d` é BSD (Mac) e não existe
// no GNU coreutils do servidor.
export function ontemStr() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone }).format(d);
}

export function hojeStrLocal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone }).format(new Date());
}
