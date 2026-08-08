import { CONFIG } from './config.js';
import { listarCalendarios, listarEventos } from './calendar.js';
import { resumoDiario, resumoSemanal } from './formatar.js';
import { iaDisponivel } from './ia.js';
import { conduzirConversa, temPendencia, iniciarRecorrente } from './conversa.js';
import { tentarCheck, listarRecorrentes, removerRecorrente } from './recorrentes.js';
import {
  marcarFeita,
  adicionarNota,
  formatarTarefas,
  formatarHistorico,
  normalizarData,
  hojeStr,
  dataCurta,
  pendentesDaSecretaria,
} from './tarefas.js';
import { t, fmtHora, CMD } from './i18n.js';

const emCmd = (lower, chave) => CMD[chave].includes(lower);

const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// "júlia", "tarefas da júlia", "o que tem com a júlia" — a mensagem inteira
// precisa ser o pedido, para não confundir com uma tarefa nova ("Júlia: ...").
const REGEX_CMD_SECRETARIA = CONFIG.secretariaNome
  ? new RegExp(
      `^(?:(?:tarefas?|lista|o que tem)\\s+)?(?:(?:d[aeo]s?|com|com [ao])\\s+)?` +
        `${semAcento(CONFIG.secretariaNome).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[?!.]*$`,
    )
  : null;

// Normaliza mensagem ditada por voz para o parser de check: números por
// extenso viram dígitos ("um, dois, vinte e três, ok" → "1, 2, 23, ok") e a
// pontuação final da transcrição ("ok.") é removida.
const NUM_PALAVRA = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, 'três': 3, quatro: 4, cinco: 5,
  seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13,
  quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17,
  dezoito: 18, dezenove: 19, vinte: 20, trinta: 30,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function normalizarVoz(lower) {
  return lower
    .replace(/\b(vinte|trinta)\s+e\s+(um|uma|dois|duas|tres|três|quatro|cinco|seis|sete|oito|nove)\b/g,
      (_, dez, unidade) => String(NUM_PALAVRA[dez] + NUM_PALAVRA[unidade]))
    .replace(/\b([a-zà-ú]+)\b/g, (palavra) => NUM_PALAVRA[palavra] ?? palavra)
    .replace(/[.!?\s]+$/, '');
}

function janela(dias, offsetDias = 0) {
  const inicio = new Date();
  inicio.setHours(0, 0, 0, 0);
  inicio.setDate(inicio.getDate() + offsetDias);
  const fim = new Date(inicio.getTime() + dias * 24 * 60 * 60 * 1000);
  return { inicio, fim };
}

export async function processarComando(texto, auth, origem = 'self') {
  const msg = texto.trim();
  const lower = msg.toLowerCase();

  // comandos rápidos só valem quando não há conversa em andamento
  if (!temPendencia(origem)) {
    // check de tarefa POR NÚMERO vem ANTES do check de recorrente: "8 ok" é
    // sempre tarefa nº 8, nunca baixa do lembrete mensal (bug real: 08/08/2026)
    // "1. feito", "2 ok", "ok 3", e múltiplos numa frase só
    // ("11, 20, 13 ok" / "ok 11 20 13") — vale também para a secretária
    // (o dono recebe aviso da ação dela via index.js)
    {
      const NUMS = String.raw`\d{1,2}(?:\s*[,;e&+]?\s+\d{1,2}|\s*[,;]\s*\d{1,2})*`;
      const lowerVoz = normalizarVoz(lower); // "Um, dois e cinco, ok." → "1, 2 e 5, ok"
      const check =
        lowerVoz.match(new RegExp(`^(${NUMS})\\s*[.\\-),]?\\s*(?:feito|feita|feitas|done|ok)\\s*$`)) ||
        lowerVoz.match(new RegExp(`^(?:feito|feita|feitas|done|ok)[:\\s,]\\s*(${NUMS})\\s*$`));
      if (check) {
        const numeros = [...new Set(check[1].match(/\d{1,2}/g).map(Number))];
        return darCheckTarefas(numeros);
      }

      // nota na tarefa: "1. nota levar o RG", "nota 2: ligar depois das 14h"
      const nota =
        msg.match(/^(\d{1,2})\s*[.\-)]?\s*(?:nota|obs|info)[:\s]+(.+)/is) ||
        msg.match(/^(?:nota|obs|info)\s+(\d{1,2})[:\s]+(.+)/is);
      if (nota) return notaTarefa(parseInt(nota[1], 10), nota[2]);
    }

    // baixa de lembrete recorrente insistente (ex.: "paguei o cartão") —
    // depois do check numérico, para nunca capturar "8 ok"
    if (origem === 'self') {
      const quitado = tentarCheck(msg);
      if (quitado) return t('rec.check.done', { title: quitado.titulo });
    }

    // tudo o que está pendente com a secretária, em qualquer data
    if (REGEX_CMD_SECRETARIA?.test(semAcento(lower))) return listarSecretariaMsg();

    // "lista"/"tarefas" (hoje) e "tarefas do dia 01/7" (histórico por data)
    if (CMD.tarefas.some((c) => lower === c || lower.startsWith(c + ' '))) {
      return listarTarefasMsg(lower);
    }

    if (emCmd(lower, 'manual')) return t('manual');
    if (emCmd(lower, 'mensal')) return iniciarRecorrente(origem);
    if (emCmd(lower, 'recorrentes') && origem === 'self') return listarRecorrentesMsg();
    if (CMD.removerRec.some((c) => lower.startsWith(c)) && origem === 'self') return removerRecorrenteMsg(msg);
    if (emCmd(lower, 'hoje')) return resumo('hoje', auth);
    if (emCmd(lower, 'amanha')) return resumo('amanha', auth);
    if (emCmd(lower, 'semana')) return resumo('semana', auth);
    if (emCmd(lower, 'livre')) return horariosLivres(auth);
    if (emCmd(lower, 'agendas')) return listarAgendas(auth);
  }

  if (!iaDisponivel) return t('no.ai');

  const resultado = await conduzirConversa(msg, auth, origem);

  // a IA identificou um pedido de resumo no meio da frase
  if (resultado && typeof resultado === 'object' && resultado.atalho) {
    const { periodo } = resultado.atalho;
    if (resultado.atalho.acao === 'livre') return horariosLivres(auth);
    return resumo(periodo ?? 'hoje', auth);
  }

  if (typeof resultado === 'string') return resultado;

  return t('not.understood');
}

async function resumo(periodo, auth) {
  if (periodo === 'semana') {
    const { inicio, fim } = janela(7);
    return resumoSemanal(await listarEventos(auth, inicio, fim), inicio);
  }
  if (periodo === 'amanha') {
    const { inicio, fim } = janela(1, 1);
    return resumoDiario(await listarEventos(auth, inicio, fim), inicio, t('daily.title.tomorrow'));
  }
  const { inicio, fim } = janela(1);
  return resumoDiario(await listarEventos(auth, inicio, fim), inicio, undefined, formatarTarefas());
}

async function horariosLivres(auth) {
  const agora = new Date();
  const fimDia = new Date(agora);
  fimDia.setHours(22, 0, 0, 0);
  if (agora >= fimDia) return t('free.dayover');

  const eventos = (await listarEventos(auth, agora, fimDia)).filter((e) => e.start?.dateTime);
  const livres = [];
  let cursor = new Date(Math.max(agora, new Date().setHours(8, 0, 0, 0)));

  for (const e of eventos) {
    const ini = new Date(e.start.dateTime);
    const fim = new Date(e.end.dateTime);
    if (ini - cursor >= 30 * 60 * 1000) livres.push([new Date(cursor), ini]);
    if (fim > cursor) cursor = fim;
  }
  if (fimDia - cursor >= 30 * 60 * 1000) livres.push([new Date(cursor), fimDia]);

  if (livres.length === 0) return t('free.full');
  const linhas = livres.map(([a, b]) => `• ${fmtHora.format(a)} – ${fmtHora.format(b)}`).join('\n');
  return t('free.header', { lines: linhas });
}

// dá check em um ou vários números de uma vez ("ok 3" / "11, 20, 13 ok")
function darCheckTarefas(numeros) {
  const feitas = [];
  const invalidos = [];
  for (const n of numeros) {
    const tarefa = marcarFeita(n);
    if (tarefa) feitas.push(tarefa);
    else invalidos.push(n);
  }
  if (feitas.length === 0) return t('task.done.badnum', { n: invalidos.join(', ') });
  const aviso = invalidos.length ? `\n⚠️ ${t('task.done.badnum', { n: invalidos.join(', ') })}` : '';
  if (feitas.length === 1) {
    return t('task.done', { text: feitas[0].texto, list: formatarTarefas() }) + aviso;
  }
  const linhas = feitas.map((x) => `• ${x.texto}`).join('\n');
  return t('task.done.multi', { n: feitas.length, lines: linhas, list: formatarTarefas() }) + aviso;
}

function notaTarefa(n, nota) {
  const tarefa = adicionarNota(n, nota);
  if (!tarefa) return t('task.done.badnum', { n });
  return t('task.note.added', { text: tarefa.texto, list: formatarTarefas() });
}

function listarTarefasMsg(lower) {
  // extrai uma data no fim do comando ("tarefas do dia 01/7", "tarefas 01/07/2026")
  const mData = lower.match(/(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})\s*$/);
  if (mData) {
    const data = normalizarData(mData[1]);
    if (!data) return t('task.list.baddate');
    const lista = formatarHistorico(data);
    if (!lista) return t('task.list.empty', { date: dataCurta(data) });
    return t('task.list.date', { date: dataCurta(data), list: lista });
  }
  if (lower.replace(/^tarefas|^tasks|^todo|^to-do|^lista|^list|de hoje|do dia/g, '').trim() !== '') {
    return t('task.list.baddate');
  }
  const lista = formatarTarefas();
  if (!lista) return t('task.list.none');
  return t('task.list.today', { list: lista });
}

function listarSecretariaMsg() {
  const pendentes = pendentesDaSecretaria();
  const nome = CONFIG.secretariaNome;
  if (pendentes.length === 0) return t('task.assist.empty', { name: nome });
  const hoje = hojeStr();
  const linhas = pendentes
    .map((x) => `• ${x.data === hoje ? t('task.today.word') : dataCurta(x.data)} — ${x.texto}`)
    .join('\n');
  return t('task.assist.header', { name: nome, n: pendentes.length, list: linhas });
}

function listarRecorrentesMsg() {
  const lista = listarRecorrentes();
  if (lista.length === 0) return t('rec.list.empty');
  const linhas = lista.map((r, i) => `(${i + 1}) *${r.titulo}* — ${t('rec.list.day', { day: r.diaDoMes })}`).join('\n');
  return t('rec.list.header', { list: linhas });
}

function removerRecorrenteMsg(msg) {
  const n = parseInt(msg.match(/\d+/)?.[0] ?? '', 10);
  const lista = listarRecorrentes();
  if (!n || !lista[n - 1]) return t('rec.remove.bad');
  const alvo = lista[n - 1];
  removerRecorrente(alvo.id);
  return t('rec.removed', { title: alvo.titulo, day: alvo.diaDoMes });
}

async function listarAgendas(auth) {
  const cals = await listarCalendarios(auth);
  const linhas = cals
    .map((c) => `• ${c.summary}${CONFIG.calendarios.includes(c.id) ? ' ✅' : ''}\n   \`${c.id}\``)
    .join('\n');
  return t('calendars.header', { list: linhas });
}
