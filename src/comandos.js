import { CONFIG } from './config.js';
import { listarCalendarios, listarEventos } from './calendar.js';
import { resumoDiario, resumoSemanal } from './formatar.js';
import { iaDisponivel } from './ia.js';
import { conduzirConversa, temPendencia, iniciarRecorrente } from './conversa.js';
import { tentarCheck, listarRecorrentes, removerRecorrente } from './recorrentes.js';
import { marcarFeita, adicionarNota, formatarTarefas, normalizarData, hojeStr, dataCurta } from './tarefas.js';
import { t, fmtHora, CMD } from './i18n.js';

const emCmd = (lower, chave) => CMD[chave].includes(lower);

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
    // baixa de lembrete recorrente insistente (ex.: "paguei o cartão")
    if (origem === 'self') {
      const quitado = tentarCheck(msg);
      if (quitado) return t('rec.check.done', { title: quitado.titulo });
    }

    // check de tarefa: "1. feito", "2 ok", "ok 3", "feito 3" — vale também
    // para a secretária (o dono recebe aviso da ação dela via index.js)
    {
      const check =
        lower.match(/^(\d{1,2})\s*[.\-)]?\s*(feito|feita|done|ok)\b/) ||
        lower.match(/^(?:feito|feita|done|ok)\s+(\d{1,2})\s*$/);
      if (check) return darCheckTarefa(parseInt(check[1], 10));

      // nota na tarefa: "1. nota levar o RG", "nota 2: ligar depois das 14h"
      const nota =
        msg.match(/^(\d{1,2})\s*[.\-)]?\s*(?:nota|obs|info)[:\s]+(.+)/is) ||
        msg.match(/^(?:nota|obs|info)\s+(\d{1,2})[:\s]+(.+)/is);
      if (nota) return notaTarefa(parseInt(nota[1], 10), nota[2]);
    }

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

function darCheckTarefa(n) {
  const tarefa = marcarFeita(n);
  if (!tarefa) return t('task.done.badnum', { n });
  return t('task.done', { text: tarefa.texto, list: formatarTarefas() });
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
    const lista = formatarTarefas(data, { historico: true });
    if (!lista) return t('task.list.empty', { date: dataCurta(data) });
    return t('task.list.date', { date: dataCurta(data), list: lista });
  }
  if (lower.replace(/^tarefas|^tasks|^todo|^to-do|^lista|^list|de hoje|do dia/g, '').trim() !== '') {
    return t('task.list.baddate');
  }
  const lista = formatarTarefas();
  if (!lista) return t('task.list.empty', { date: dataCurta(hojeStr()) });
  return t('task.list.today', { date: dataCurta(hojeStr()), list: lista });
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
