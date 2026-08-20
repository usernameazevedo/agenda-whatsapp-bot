// Regressão da recuperação de jobs de horário fixo (src/jobs.js).
//
// Rodar:  node test/jobs-atrasados.mjs
//
// O caso 10 é o incidente real de 20/08/2026: o Mac dormiu 06:56:08 → 07:00:24,
// o node-cron pulou o minuto das 7h e o resumo diário nunca rodou.
// Os casos 16-18 cobrem a corrida entre o cron e a recuperação por reconexão,
// que mandaria o mesmo resumo duas vezes ao grupo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Precisa vir ANTES do import de jobs.js: sem isso a suíte escreveria no
// execucoes.json de verdade e faria o bot pular o resumo do dia.
const ARQUIVO = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-teste-')), 'execucoes.json');
process.env.AGENDA_EXECUCOES = ARQUIVO;

const { horarioDoCron, semanaCombina, agoraLocal, ficouParaTras, umaVezPorDia, lerExecucoes } =
  await import('../src/jobs.js');

const TZ = 'America/Sao_Paulo';
const resultados = [];

function conferir(nome, esperado, obtido) {
  const ok = JSON.stringify(esperado) === JSON.stringify(obtido);
  resultados.push(ok);
  console.log(`${ok ? 'PASSA' : 'FALHA'}  ${nome}`);
  if (!ok) console.log(`        esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`);
}

// --- leitura da expressão -----------------------------------------------
conferir('1. lê horário fixo', { minuto: 0, hora: 7, semana: '*' }, horarioDoCron('0 7 * * *'));
conferir('2. lembretes (* * * * *) não é recuperável', null, horarioDoCron('* * * * *'));
conferir('3. dia do mês específico não é recuperável', null, horarioDoCron('0 7 8 * *'));

// --- dia da semana -------------------------------------------------------
conferir('4. briefing 1-6 não roda domingo', false, semanaCombina('1-6', 0));
conferir('5. briefing 1-6 roda quarta', true, semanaCombina('1-6', 3));
conferir('6. "*" roda todo dia', true, semanaCombina('*', 0));
conferir('7. semanal "1" só na segunda', true, semanaCombina('1', 1));
conferir('8. semanal "1" não na terça', false, semanaCombina('1', 2));
conferir('9a. lista "1,3,5" pega quarta', true, semanaCombina('1,3,5', 3));
conferir('9b. lista "1,3,5" não pega terça', false, semanaCombina('1,3,5', 2));
conferir('9c. no cron, 7 também é domingo', true, semanaCombina('7', 0));
conferir('9d. faixa que vira a semana (5-1) pega domingo', true, semanaCombina('5-1', 0));

// --- relógio no fuso do bot ---------------------------------------------
// 14:00Z = 11:00 em São Paulo, quinta-feira.
const agora = agoraLocal(TZ, new Date('2026-08-20T14:00:00Z'));
conferir('10a. hora local no fuso certo', { dia: '2026-08-20', minutos: 660, semana: 4 }, agora);
// 02:00Z = 23:00 do dia anterior em São Paulo: a data tem de recuar junto.
conferir(
  '10b. virada de dia no fuso',
  { dia: '2026-08-19', minutos: 1380, semana: 3 },
  agoraLocal(TZ, new Date('2026-08-20T02:00:00Z')),
);

// --- a decisão -----------------------------------------------------------
conferir('11. INCIDENTE 20/08: diário das 7h não rodou hoje -> recupera', true,
  ficouParaTras('0 7 * * *', '2026-08-19', agora));
conferir('12. já rodou hoje -> não repete', false,
  ficouParaTras('0 7 * * *', '2026-08-20', agora));
conferir('13. ainda não deu a hora (noturno 21h, agora 11h) -> espera', false,
  ficouParaTras('0 21 * * *', '2026-08-19', agora));
conferir('14. job nunca visto -> não dispara enxurrada no primeiro boot', false,
  ficouParaTras('0 7 * * *', undefined, agora));
conferir('15. semanal de segunda, hoje é quinta -> não recupera', false,
  ficouParaTras('0 7 * * 1', '2026-08-17', agora));
conferir('16. lembretes nunca são recuperados', false,
  ficouParaTras('* * * * *', '2026-08-19', agora));

// --- execução: uma vez por dia, e uma vez só sob concorrência -----------
const HOJE = '2026-08-20';
const lento = (contador) => () => new Promise((r) => setTimeout(() => { contador.n += 1; r(); }, 60));

{
  const c = { n: 0 };
  const rodou = await umaVezPorDia('alfa', HOJE, lento(c));
  const denovo = await umaVezPorDia('alfa', HOJE, lento(c));
  conferir('17. roda uma vez no dia, a segunda chamada é no-op', [true, false, 1], [rodou, denovo, c.n]);
}

{
  // CORRIDA: cron às 07:00:00 e recuperação por reconexão a segundos dele.
  // Sem trava, os dois leem a marca velha e o resumo sai DUAS vezes.
  const c = { n: 0 };
  const [a, b] = await Promise.all([
    umaVezPorDia('beta', HOJE, lento(c)),
    umaVezPorDia('beta', HOJE, lento(c)),
  ]);
  conferir('18. CORRIDA cron x reconexão: executa uma vez só', [true, false, 1], [a, b, c.n]);
}

{
  // Falha não pode marcar como feito, senão o job some pelo resto do dia.
  const c = { n: 0 };
  let explodiu = false;
  try {
    await umaVezPorDia('gama', HOJE, async () => { throw new Error('envio falhou'); });
  } catch { explodiu = true; }
  const marcado = lerExecucoes().gama;
  const tentouDeNovo = await umaVezPorDia('gama', HOJE, lento(c));
  conferir('19. falha não grava marca e o job é tentado de novo',
    [true, undefined, true, 1], [explodiu, marcado, tentouDeNovo, c.n]);
}

fs.rmSync(path.dirname(ARQUIVO), { recursive: true, force: true });

const falhas = resultados.filter((ok) => !ok).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} passaram`);
process.exit(falhas ? 1 : 0);
