// Fluxo de conversa com estado: coleta de dados, desambiguação, confirmação S/N,
// aviso de dia sobrecarregado e follow-up de orçamento.
import { CONFIG } from './config.js';
import {
  buscarEventoPorTitulo,
  criarEvento,
  deletarEvento,
  listarEventos,
  remarcarEvento,
  renomearEvento,
} from './calendar.js';
import { interpretar, gerarTexto } from './ia.js';
import { criarFollowup, paraCobrar, atualizarFollowup } from './followups.js';
import { criarRecorrente } from './recorrentes.js';
import { t, fmtDataHora, fmtHora, fmtDia, ehSim, ehNao } from './i18n.js';

const PENDENCIA_TTL_MIN = 10;
const DURACAO_PADRAO_MIN = 60;
const REGEX_ORCAMENTO = /or[çc]ament|proposta|quote|proposal/i;

// usuário único: uma pendência global cobre qualquer formato de chat (@c.us / @lid)
const DEFAULT_KEY = 'self';
const pendencias = new Map();

const dataDoEvento = (e) => new Date(e.start?.dateTime ?? `${e.start?.date}T12:00:00`);
const linhaCandidato = (e, i) => `(${i + 1}) ${e.summary} — ${fmtDataHora.format(dataDoEvento(e))}`;

function limparExpiradas() {
  const agora = Date.now();
  for (const [k, v] of pendencias) {
    // perguntas de follow-up podem esperar o dia todo; o resto expira rápido
    const ttlMin = v.fase?.startsWith('followup') || v.fase === 'checkdia' ? 12 * 60 : PENDENCIA_TTL_MIN;
    if (agora - v.criadoEm > ttlMin * 60 * 1000) pendencias.delete(k);
  }
}

export function temPendencia(key = DEFAULT_KEY) {
  limparExpiradas();
  return pendencias.has(key);
}

// ─── fluxo principal ─────────────────────────────────────────────────────────

export async function conduzirConversa(texto, auth, key = DEFAULT_KEY) {
  limparExpiradas();
  const pend = pendencias.get(key) ?? null;

  if (pend) return responderPendencia(texto, pend, auth, key);

  const intent = await interpretar(texto);
  if (!intent || intent.acao === 'nada') return null;
  if (intent.acao === 'resumo' || intent.acao === 'livre') return { atalho: intent };

  // lembrete recorrente mensal insistente (ex.: pagar o cartão dia 10 de todo mês)
  if (intent.recorrente) {
    return avancarRecorrente(
      { fase: 'rec_slots', dados: { titulo: intent.titulo ?? null, diaDoMes: intent.diaDoMes ?? null }, criadoEm: Date.now() },
      key
    );
  }

  const novo = {
    fase: 'slots',
    acao: intent.acao,
    dados: {
      titulo: intent.titulo ?? null,
      busca: intent.busca ?? null,
      inicio: intent.inicio ?? null,
      fim: intent.fim ?? null,
      lembrete: intent.lembrete ?? false,
    },
    candidatos: [],
    criadoEm: Date.now(),
  };
  return avancar(novo, auth, key);
}

async function responderPendencia(texto, pend, auth, key) {
  // fases de follow-up e checagem têm regras próprias
  if (pend.fase === 'followup_dias') return responderFollowupDias(texto, pend, key);
  if (pend.fase === 'followup_resposta') return responderFollowupResposta(texto, pend, auth, key);
  if (pend.fase === 'followup_texto') return responderFollowupTexto(texto, pend, key);
  if (pend.fase === 'checkdia') return responderCheckDia(texto, pend, auth, key);
  if (pend.fase === 'rec_slots') return responderRecSlots(texto, pend, key);
  if (pend.fase === 'rec_confirma') return responderRecConfirma(texto, pend, key);

  if (ehNao(texto)) {
    pendencias.delete(key);
    if (pend.fase === 'confirma' && pend.sobrecarga) return t('discard.overload');
    return t('discard.generic');
  }

  if (pend.fase === 'confirma' && ehSim(texto)) {
    pendencias.delete(key);
    return executar(pend, auth, key);
  }

  if (pend.fase === 'escolha') {
    const escolhido = escolherCandidato(texto, pend.candidatos);
    if (!escolhido) return t('ask.option.number');
    pend.dados.evento = escolhido;
    return avancar(pend, auth, key);
  }

  if (pend.fase === 'operacao') {
    const op = texto.trim().match(/^[123]/)?.[0];
    if (op === '1') {
      pend.acao = 'agendar';
      delete pend.dados.evento;
    } else if (op === '2') pend.acao = 'remarcar';
    else if (op === '3') pend.acao = 'cancelar';
    else return t('ask.op.123');
    return avancar(pend, auth, key);
  }

  // fase 'slots' ou informação nova durante confirmação
  const intent = await interpretar(texto, pend.dados);
  if (intent) mesclar(pend.dados, intent);
  return avancar(pend, auth, key);
}

function mesclar(dados, intent) {
  if (intent.titulo) dados.titulo = intent.titulo;
  if (intent.busca) dados.busca = intent.busca;
  if (intent.inicio) {
    dados.inicio = intent.inicio;
    if (!intent.fim) dados.fim = null; // recalcula o padrão de 1h a partir do novo início
  }
  if (intent.fim) dados.fim = intent.fim;
  if (intent.lembrete !== undefined) dados.lembrete = intent.lembrete;
}

// ─── decide o próximo passo ──────────────────────────────────────────────────

async function avancar(pend, auth, key = DEFAULT_KEY) {
  pend.criadoEm = Date.now();
  pendencias.set(key, pend);

  if (pend.acao === 'agendar') {
    const d = pend.dados;
    if (!d.titulo) { pend.fase = 'slots'; return t('ask.what'); }
    if (!d.inicio) { pend.fase = 'slots'; return t('ask.when', { title: d.titulo }); }
    // duração padrão de 1h quando o fim não é informado
    if (!d.fim) d.fim = new Date(new Date(d.inicio).getTime() + DURACAO_PADRAO_MIN * 60 * 1000).toISOString();

    // conflito de nome com evento existente
    if (!pend.conflitoVerificado) {
      pend.conflitoVerificado = true;
      const parecidos = await buscarEventoPorTitulo(auth, d.titulo, 30);
      if (parecidos.length > 0) {
        pend.candidatos = parecidos.slice(0, 5);
        pend.fase = 'operacao';
        pend.dados.evento = parecidos[0];
        return t('conflict.header', { list: pend.candidatos.map(linhaCandidato).join('\n') });
      }
    }

    // aviso de dia sobrecarregado
    const aviso = await avisoSobrecarga(auth, d);
    pend.sobrecarga = Boolean(aviso);
    pend.fase = 'confirma';
    const vars = {
      title: d.titulo,
      start: fmtDataHora.format(new Date(d.inicio)),
      end: fmtHora.format(new Date(d.fim)),
    };
    return aviso ? t('confirm.create.overload', { ...vars, warn: aviso }) : t('confirm.create', vars);
  }

  if (pend.acao === 'cancelar' || pend.acao === 'remarcar') {
    const d = pend.dados;
    if (!d.evento) {
      const busca = d.busca ?? d.titulo;
      if (!busca) { pend.fase = 'slots'; return t('ask.which'); }
      const achados = await buscarEventoPorTitulo(auth, busca, 30);
      if (achados.length === 0) {
        pendencias.delete(key);
        return t('notfound', { q: busca });
      }
      if (achados.length > 1) {
        pend.candidatos = achados.slice(0, 5);
        pend.fase = 'escolha';
        return t('ask.whichone', { list: pend.candidatos.map(linhaCandidato).join('\n') });
      }
      d.evento = achados[0];
    }

    if (pend.acao === 'remarcar' && !d.inicio) {
      pend.fase = 'slots';
      return t('ask.newtime', { title: d.evento.summary, when: fmtDataHora.format(dataDoEvento(d.evento)) });
    }

    pend.fase = 'confirma';
    if (pend.acao === 'cancelar') {
      return t('confirm.cancel', { title: d.evento.summary, when: fmtDataHora.format(dataDoEvento(d.evento)) });
    }
    return t('confirm.reschedule', {
      title: d.evento.summary,
      from: fmtDataHora.format(dataDoEvento(d.evento)),
      to: fmtDataHora.format(new Date(d.inicio)),
    });
  }

  pendencias.delete(key);
  return null;
}

async function avisoSobrecarga(auth, dados) {
  const inicio = new Date(dados.inicio);
  const diaIni = new Date(inicio); diaIni.setHours(0, 0, 0, 0);
  const diaFim = new Date(diaIni.getTime() + 24 * 60 * 60 * 1000);
  const eventos = (await listarEventos(auth, diaIni, diaFim)).filter((e) => e.start?.dateTime && e.end?.dateTime);
  const ocupadoMs = eventos.reduce((s, e) => s + (new Date(e.end.dateTime) - new Date(e.start.dateTime)), 0);
  const novoMs = new Date(dados.fim) - inicio;
  const totalHoras = (ocupadoMs + novoMs) / 3600000;
  if (totalHoras <= CONFIG.limiteHorasDia) return null;
  const horasOcupadas = Math.round((ocupadoMs / 3600000) * 10) / 10;
  return t('overload.warn', {
    day: fmtDia.format(inicio),
    hours: horasOcupadas,
    n: eventos.length,
    s: eventos.length > 1 ? 's' : '',
  });
}

function escolherCandidato(texto, candidatos) {
  const t = texto.trim();
  const num = t.match(/^(\d)\b/);
  if (num) {
    const i = parseInt(num[1], 10) - 1;
    if (candidatos[i]) return candidatos[i];
  }
  return null;
}

// ─── execução ────────────────────────────────────────────────────────────────

async function executar(pend, auth, key = DEFAULT_KEY) {
  const d = pend.dados;
  if (pend.acao === 'agendar') {
    const inicio = new Date(d.inicio);
    const fim = d.fim ? new Date(d.fim) : new Date(inicio.getTime() + DURACAO_PADRAO_MIN * 60 * 1000);
    const evento = await criarEvento(auth, { titulo: d.titulo, inicio, fim, lembrete: Boolean(d.lembrete) });
    let msg = t('done.created', { title: d.titulo, when: fmtDataHora.format(inicio), link: evento.htmlLink ?? '' });

    // follow-up automático de orçamento
    if (REGEX_ORCAMENTO.test(d.titulo)) {
      pendencias.set(key, {
        fase: 'followup_dias',
        cliente: d.titulo,
        dataEnvio: inicio.toISOString(),
        criadoEm: Date.now(),
      });
      msg += t('followup.offer');
    }
    return msg;
  }
  if (pend.acao === 'cancelar') {
    await deletarEvento(auth, d.evento);
    return t('done.canceled', { title: d.evento.summary });
  }
  if (pend.acao === 'remarcar') {
    await remarcarEvento(auth, d.evento, new Date(d.inicio));
    return t('done.rescheduled', { title: d.evento.summary, when: fmtDataHora.format(new Date(d.inicio)) });
  }
  return null;
}

// ─── follow-up de orçamento ──────────────────────────────────────────────────

function responderFollowupDias(texto, pend, key) {
  if (ehNao(texto)) {
    pendencias.delete(key);
    return t('followup.no');
  }
  const n = parseInt(texto.trim().match(/\d+/)?.[0] ?? '', 10);
  if (!n || n < 1 || n > 90) return t('followup.askdays');
  criarFollowup({ cliente: pend.cliente, dataEnvio: pend.dataEnvio, prazoDias: n });
  pendencias.delete(key);
  return t('followup.set', { n, s: n > 1 ? 's' : '' });
}

async function responderFollowupResposta(texto, pend, auth, key) {
  if (ehSim(texto)) {
    atualizarFollowup(pend.followupId, { status: 'respondido' });
    pendencias.delete(key);
    return t('followup.closed');
  }
  if (ehNao(texto)) {
    atualizarFollowup(pend.followupId, { status: 'cobrar' });
    const inicio = new Date();
    inicio.setMinutes(0, 0, 0);
    inicio.setHours(inicio.getHours() + 1);
    const fim = new Date(inicio.getTime() + 30 * 60 * 1000);
    await criarEvento(auth, { titulo: t('followup.chase.title', { client: pend.cliente }), inicio, fim });
    pend.fase = 'followup_texto';
    pend.criadoEm = Date.now();
    pendencias.set(key, pend);
    return t('followup.reminderset', { time: fmtHora.format(inicio) });
  }
  return t('followup.askreturn', { client: pend.cliente });
}

async function responderFollowupTexto(texto, pend, key) {
  pendencias.delete(key);
  if (!ehSim(texto)) return t('followup.ok');
  const sugestao = await gerarTexto(t('ia.chase.prompt', { client: pend.cliente }));
  return sugestao ? t('followup.draft', { text: sugestao }) : t('followup.draftfail');
}

// ─── lembretes recorrentes mensais insistentes ───────────────────────────────

// Atalho: começa o assistente de criação (comando "mensal")
export function iniciarRecorrente(key = DEFAULT_KEY) {
  return avancarRecorrente({ fase: 'rec_slots', dados: { titulo: null, diaDoMes: null }, criadoEm: Date.now() }, key);
}

// extrai "dia N" de uma frase e devolve { titulo, dia }
function extrairTituloEDia(texto) {
  const t = texto.trim();
  const m = t.match(/\bdia\s+(\d{1,2})\b/i) || t.match(/\b(\d{1,2})\b/);
  const dia = m ? parseInt(m[1], 10) : null;
  const titulo = t
    .replace(/\bdia\s+\d{1,2}\b/gi, '')
    .replace(/\b(de\s+)?(todo|cada|por)\s+m[êe]s\b/gi, '')
    .replace(/\bmensal\b/gi, '')
    .replace(/\b\d{1,2}\b/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .replace(/\s+(de|do|da|no|na|por|e)$/i, '')
    .trim();
  return { titulo: titulo || null, dia: dia && dia >= 1 && dia <= 31 ? dia : null };
}

function avancarRecorrente(pend, key) {
  pend.criadoEm = Date.now();
  pendencias.set(key, pend);
  const d = pend.dados;
  if (!d.titulo && !d.diaDoMes) { pend.fase = 'rec_slots'; return t('rec.ask.both'); }
  if (!d.titulo) { pend.fase = 'rec_slots'; return t('rec.ask.title'); }
  if (!d.diaDoMes) { pend.fase = 'rec_slots'; return t('rec.ask.day', { title: d.titulo }); }
  pend.fase = 'rec_confirma';
  return t('rec.confirm', { day: d.diaDoMes, title: d.titulo });
}

function responderRecSlots(texto, pend, key) {
  const d = pend.dados;
  // primeira resposta: tenta extrair título + dia de uma frase só
  if (!d.titulo && !d.diaDoMes) {
    const { titulo, dia } = extrairTituloEDia(texto);
    if (titulo) d.titulo = titulo;
    if (dia) d.diaDoMes = dia;
  } else if (!d.titulo) {
    d.titulo = texto.trim();
  } else if (!d.diaDoMes) {
    const n = parseInt(texto.match(/\d+/)?.[0] ?? '', 10);
    if (!n || n < 1 || n > 31) return t('rec.badday');
    d.diaDoMes = n;
  }
  return avancarRecorrente(pend, key);
}

function responderRecConfirma(texto, pend, key) {
  if (ehNao(texto)) {
    pendencias.delete(key);
    return t('rec.discard');
  }
  if (ehSim(texto)) {
    pendencias.delete(key);
    const d = pend.dados;
    criarRecorrente({ titulo: d.titulo, diaDoMes: d.diaDoMes });
    return t('rec.created', { title: d.titulo, day: d.diaDoMes });
  }
  return t('rec.ask.confirm');
}

// ─── checagem de fim de dia dos lembretes ────────────────────────────────────

const ehLembrete = (e) =>
  e.extendedProperties?.private?.agendaBot === 'lembrete' ||
  /lembrete|lembrar|cobrar|reminder|remind|chase/i.test(e.summary ?? '');

// Monta a checagem do dia; retorna a primeira pergunta ou null se não há lembretes.
export async function dispararCheckDia(auth) {
  limparExpiradas();
  if (pendencias.has(DEFAULT_KEY)) return null; // não interrompe conversa em andamento
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const amanha = new Date(hoje.getTime() + 24 * 60 * 60 * 1000);
  const fila = (await listarEventos(auth, hoje, amanha))
    .filter((e) => ehLembrete(e) && !(e.summary ?? '').startsWith('✅'));
  if (fila.length === 0) return null;
  pendencias.set(DEFAULT_KEY, { fase: 'checkdia', fila, idx: 0, criadoEm: Date.now() });
  return t('checkdia.start', { n: fila.length, s: fila.length > 1 ? 's' : '', title: fila[0].summary });
}

async function responderCheckDia(texto, pend, auth, key) {
  const evento = pend.fila[pend.idx];
  let resultado;
  if (ehSim(texto)) {
    await renomearEvento(auth, evento, `✅ ${evento.summary}`);
    resultado = t('checkdia.markeddone', { title: evento.summary });
  } else if (ehNao(texto)) {
    const novoInicio = new Date(dataDoEvento(evento).getTime() + 24 * 60 * 60 * 1000);
    await remarcarEvento(auth, evento, novoInicio);
    resultado = t('checkdia.postponed', { title: evento.summary, when: fmtDataHora.format(novoInicio) });
  } else {
    return t('checkdia.ask', { title: evento.summary });
  }

  pend.idx += 1;
  if (pend.idx >= pend.fila.length) {
    pendencias.delete(key);
    return t('checkdia.finished', { result: resultado });
  }
  pend.criadoEm = Date.now();
  pendencias.set(key, pend);
  return t('checkdia.next', { result: resultado, title: pend.fila[pend.idx].summary });
}

// Chamado pelo cron diário (09:00): dispara a pergunta de cobrança pendente.
export async function dispararCobrancas(enviar) {
  limparExpiradas();
  if (pendencias.has(DEFAULT_KEY)) return; // não interrompe uma conversa em andamento
  const [devido] = paraCobrar();
  if (!devido) return;
  atualizarFollowup(devido.id, { status: 'perguntado' });
  pendencias.set(DEFAULT_KEY, {
    fase: 'followup_resposta',
    followupId: devido.id,
    cliente: devido.cliente,
    criadoEm: Date.now(),
  });
  await enviar(t('followup.due', { client: devido.cliente }));
}
