// Jobs de horário fixo que precisam sobreviver ao sono da máquina.
//
// O node-cron não recupera o que perdeu. Em `scheduler.js` ele só dispara o
// segundo atual (`i === 0`) a menos que `recoverMissedExecutions` esteja
// ligado — e mesmo ligado depende de `process.hrtime()`, que pode não avançar
// enquanto o Mac dorme. Medido em 20/08/2026: a máquina dormiu às 06:56:08 e
// acordou às 07:00:24; o resumo das 7h simplesmente não saiu, e as tarefas
// pendentes do dia anterior não foram postergadas.
//
// A defesa aqui não depende de relógio nenhum: guardamos em disco o DIA da
// última execução de cada job e, ao reconectar, rodamos o que ficou para trás.
import fs from 'node:fs';

// O override por env existe para os testes rodarem sem tocar o arquivo real —
// sem ele, rodar a suíte no repo de produção marcaria jobs como já executados
// e faria o bot pular o resumo do dia.
const ARQUIVO = process.env.AGENDA_EXECUCOES ?? new URL('../execucoes.json', import.meta.url).pathname;

// Jobs rodando neste instante. O cron e a recuperação por reconexão podem
// disparar o mesmo job a segundos de distância (medido em 20/08/2026: cron às
// 07:00:00 e reconexão às 07:00:31), e a marca em disco só é gravada DEPOIS do
// job terminar — então, sem esta trava, os dois leriam a marca velha e o
// resumo sairia duas vezes. Mesmo padrão do `outboxOcupada` no index.js.
const emExecucao = new Set();

// Nomes curtos de dia da semana → 0-6, para casar com o campo do cron.
const DIAS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Lê uma expressão cron de horário fixo ("M H * * D") e devolve
 * `{ minuto, hora, semana }`. Qualquer outro formato devolve null — é assim
 * que `* * * * *` (lembretes) fica de fora da recuperação, o que é proposital:
 * recuperar uma hora dormida de lembretes de minuto em minuto despejaria
 * centenas de execuções de uma vez.
 */
export function horarioDoCron(expr) {
  const partes = String(expr ?? '').trim().split(/\s+/);
  if (partes.length !== 5) return null;
  const [minuto, hora, dia, mes, semana] = partes;
  if (dia !== '*' || mes !== '*') return null;
  if (!/^\d{1,2}$/.test(minuto) || !/^\d{1,2}$/.test(hora)) return null;
  return { minuto: Number(minuto), hora: Number(hora), semana };
}

/** Casa o campo de dia da semana do cron (`*`, `1`, `1-6`, `1,3,5`) com 0-6. */
export function semanaCombina(spec, diaDaSemana) {
  if (spec === '*') return true;
  return String(spec).split(',').some((parte) => {
    const faixa = parte.match(/^(\d)-(\d)$/);
    if (faixa) {
      // No cron, 7 também é domingo.
      const de = Number(faixa[1]) % 7;
      const ate = Number(faixa[2]) % 7;
      return de <= ate
        ? diaDaSemana >= de && diaDaSemana <= ate
        : diaDaSemana >= de || diaDaSemana <= ate; // faixa que vira a semana
    }
    return /^\d$/.test(parte) && Number(parte) % 7 === diaDaSemana;
  });
}

/** Instante atual no fuso do bot: `{ dia, minutos, semana }`. */
export function agoraLocal(timezone, quando = new Date()) {
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(quando);
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(quando);
  const pegar = (tipo) => partes.find((p) => p.type === tipo)?.value;
  // 'en-US' com hour12:false devolve 24 para a meia-noite; %24 normaliza.
  const hora = Number(pegar('hour')) % 24;
  return {
    dia,
    minutos: hora * 60 + Number(pegar('minute')),
    semana: DIAS[pegar('weekday')] ?? 0,
  };
}

/**
 * O job ficou para trás? Verdadeiro quando hoje é dia dele, o horário já
 * passou e a marca em disco não é de hoje.
 *
 * `ultimaExecucao` indefinida devolve false de propósito: subir o bot às 15h
 * pela primeira vez não pode disparar de uma vez o resumo das 7h, a
 * verificação das 6h e o diagnóstico das 8h. O job passa a ser recuperável só
 * depois de ter rodado uma vez pelo horário normal.
 */
export function ficouParaTras(expr, ultimaExecucao, agora) {
  const horario = horarioDoCron(expr);
  if (!horario) return false;
  if (ultimaExecucao === undefined) return false;
  if (ultimaExecucao === agora.dia) return false;
  if (!semanaCombina(horario.semana, agora.semana)) return false;
  return agora.minutos >= horario.hora * 60 + horario.minuto;
}

export function lerExecucoes() {
  try {
    const reg = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    return reg && typeof reg === 'object' ? reg : {};
  } catch (err) {
    // Arquivo ausente é o caso normal do primeiro dia e não merece ruído.
    // Arquivo ilegível é outra coisa: perder as marcas significa perder a
    // recuperação do dia, então isso precisa aparecer no log.
    if (err.code !== 'ENOENT') console.error(`execucoes.json ilegível (${err.message}) — marcas do dia perdidas.`);
    return {};
  }
}

export function marcarExecucao(nome, dia) {
  const reg = lerExecucoes();
  reg[nome] = dia;
  try {
    fs.writeFileSync(ARQUIVO, JSON.stringify(reg, null, 1));
  } catch (err) {
    console.error(`Falha ao marcar execução de "${nome}":`, err.message);
  }
}

/**
 * Executa `fn` no máximo uma vez por `dia`. Devolve true se executou.
 *
 * A marca só é gravada DEPOIS do sucesso: job que falhou volta a ser tentado
 * na próxima reconexão, em vez de ficar marcado como feito. A trava em memória
 * cobre o intervalo entre ler a marca e gravá-la, quando o cron e a
 * recuperação podem disparar o mesmo job em paralelo — repetir o envio não é
 * inofensivo, o resumo chegaria duas vezes ao grupo.
 */
export async function umaVezPorDia(nome, dia, fn) {
  if (emExecucao.has(nome)) return false;
  if (lerExecucoes()[nome] === dia) return false;
  emExecucao.add(nome);
  try {
    await fn();
    marcarExecucao(nome, dia);
    return true;
  } finally {
    emExecucao.delete(nome);
  }
}
