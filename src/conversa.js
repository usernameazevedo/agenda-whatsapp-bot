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
import { interpretar } from './ia.js';
import { interpretarComAgente, agenteDisponivel } from './agente.js';
import { criarFollowup } from './followups.js';
import { criarRecorrente } from './recorrentes.js';
import { criarTarefa, tarefasDoDia, pendentesDoDia, marcarFeitaPorId, formatarTarefas, hojeStr, dataCurta, buscarPendentePorTexto, adicionarNotaPorId, atualizarInfoPorId } from './tarefas.js';
import { t, fmtDataHora, fmtHora, fmtDia, ehSim, ehNao } from './i18n.js';

const PENDENCIA_TTL_MIN = 10;
const DURACAO_PADRAO_MIN = 60;
const REGEX_ORCAMENTO = /or[çc]ament|proposta|quote|proposal/i;

// usuário único: uma pendência global cobre qualquer formato de chat (@c.us / @lid)
const DEFAULT_KEY = 'self';
const pendencias = new Map();

// memória curta da conversa: últimas mensagens viram contexto para a IA
// (permite "marca o dentista com essas informações" após encaminhar algo)
const HISTORICO_MAX = 6;
const HISTORICO_TTL_MIN = 30;
const historicos = new Map();

function contextoRecente(key) {
  const corte = Date.now() - HISTORICO_TTL_MIN * 60 * 1000;
  return (historicos.get(key) ?? []).filter((m) => m.em > corte).map((m) => m.texto);
}

function lembrarMensagem(key, texto) {
  const corte = Date.now() - HISTORICO_TTL_MIN * 60 * 1000;
  const atuais = (historicos.get(key) ?? []).filter((m) => m.em > corte);
  if (atuais[atuais.length - 1]?.texto === texto) return; // reentrada da mesma mensagem
  historicos.set(key, [...atuais, { texto, em: Date.now() }].slice(-HISTORICO_MAX));
}

// ─── proteção contra dia da semana trocado pela IA ───────────────────────────
// Se o usuário citou "sexta" e a data interpretada cai no sábado, o confirmatório
// ganha um alerta explícito (a IA já errou essa conversão em produção).
const NOMES_DIA = [
  ['domingo', 'sunday'], ['segunda', 'monday'], ['terça', 'terca', 'tuesday'],
  ['quarta', 'wednesday'], ['quinta', 'thursday'], ['sexta', 'friday'],
  ['sábado', 'sabado', 'saturday'],
];

function extrairDiaSemanaCitado(texto) {
  const s = texto.toLowerCase();
  for (let i = 0; i < 7; i++) {
    if (NOMES_DIA[i].some((n) => new RegExp(`\\b${n}\\b`).test(s))) return i;
  }
  return null;
}

const diaSemanaEm = (data) =>
  new Date(new Date(data).toLocaleString('en-US', { timeZone: CONFIG.timezone })).getDay();

// Se a data interpretada não cai no dia citado, CORRIGE para a próxima
// ocorrência desse dia da semana (mantendo o horário) e avisa na confirmação.
// A IA já converteu "sexta" em sábado em produção — o dia citado pelo usuário
// é a fonte da verdade, não a data que o modelo devolveu.
export function corrigirDiaSemana(pend) {
  const d = pend.dados;
  if (pend.diaCitado == null || !d.inicio) return '';
  if (diaSemanaEm(d.inicio) === pend.diaCitado) return '';

  const duracaoMs = d.fim ? new Date(d.fim) - new Date(d.inicio) : null;
  // horário citado, no fuso do bot
  const [hh, mm] = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: CONFIG.timezone,
  }).format(new Date(d.inicio)).split(':');

  // próxima ocorrência do dia citado a partir de hoje (se for hoje e o horário
  // já passou, vai para a semana seguinte)
  const hojeData = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone }).format(new Date());
  for (let add = 0; add <= 7; add++) {
    const dia = new Date(`${hojeData}T${hh}:${mm}:00-03:00`);
    dia.setDate(dia.getDate() + add);
    if (diaSemanaEm(dia) !== pend.diaCitado) continue;
    if (dia <= new Date()) continue;
    const anterior = new Date(d.inicio);
    d.inicio = dia.toISOString();
    d.fim = duracaoMs ? new Date(dia.getTime() + duracaoMs).toISOString() : null;
    if (!d.fim) d.fim = new Date(dia.getTime() + DURACAO_PADRAO_MIN * 60 * 1000).toISOString();
    return '\n' + t('weekday.fixed', {
      said: NOMES_DIA[pend.diaCitado][0],
      wrong: fmtDataHora.format(anterior),
    });
  }
  return '';
}

const dataDoEvento = (e) => new Date(e.start?.dateTime ?? `${e.start?.date}T12:00:00`);
const linhaCandidato = (e, i) => `(${i + 1}) ${e.summary} — ${fmtDataHora.format(dataDoEvento(e))}`;

function limparExpiradas() {
  const agora = Date.now();
  for (const [k, v] of pendencias) {
    if (agora - v.criadoEm > PENDENCIA_TTL_MIN * 60 * 1000) pendencias.delete(k);
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

  const contexto = contextoRecente(key);
  lembrarMensagem(key, texto); // toda mensagem vira contexto, mesmo respondendo pendência

  if (pend) return responderPendencia(texto, pend, auth, key);

  // mensagem nova: agente com ferramentas (consulta a agenda antes de decidir);
  // se falhar, cai no interpretador simples
  let intent = null;
  if (agenteDisponivel) {
    try {
      intent = await interpretarComAgente(texto, auth, contexto);
    } catch (err) {
      console.error('Agente falhou, usando interpretador simples:', err.message);
    }
  }
  if (!intent) intent = await interpretar(texto);
  if (!intent || intent.acao === 'nada') return null;
  if (intent.acao === 'responder' && intent.resposta) return intent.resposta;
  if (intent.acao === 'resumo' || intent.acao === 'livre') return { atalho: intent };

  // conclusão por nome: "Gravação Hugo, feito" → dá baixa em tarefa ou evento de hoje
  if (intent.acao === 'concluir') {
    return concluirPorNome(tituloValido(intent.busca ?? intent.titulo), auth);
  }

  // registro de orçamento enviado → oferece cobrança automática de retorno
  if (intent.acao === 'orcamento_enviado') {
    const cliente = tituloValido(intent.titulo);
    if (!cliente) {
      pendencias.set(key, { fase: 'orc_cliente', criadoEm: Date.now() });
      return t('orc.ask.client');
    }
    pendencias.set(key, {
      fase: 'followup_dias',
      cliente,
      dataEnvio: new Date().toISOString(),
      criadoEm: Date.now(),
    });
    return t('orc.registered', { client: cliente });
  }

  // acrescenta informação a uma tarefa existente: nota livre e/ou campos
  // estruturados (horário, local, cliente, detalhes) — só quando pedido
  const temCampos = intent.campos && Object.values(intent.campos).some((v) => (v ?? '').toString().trim());
  if (intent.acao === 'tarefa_nota' && (intent.nota || temCampos)) {
    const achadas = buscarPendentePorTexto(intent.busca ?? intent.titulo ?? '');
    if (achadas.length === 0) {
      const lista = formatarTarefas();
      return lista
        ? t('task.note.notfound', { q: intent.busca ?? '', list: lista })
        : t('task.list.empty', { date: dataCurta(hojeStr()) });
    }
    const alvo = achadas[0];
    if (temCampos) atualizarInfoPorId(alvo.id, intent.campos);
    if (intent.nota) adicionarNotaPorId(alvo.id, intent.nota);
    return t('task.note.added', { text: alvo.texto, list: formatarTarefas() });
  }

  // tarefa do dia (a fazer sem horário): "tenho que ligar pro fulano", "preciso mandar o documento"
  if (intent.acao === 'tarefa') {
    // várias tarefas numa mensagem só (cada uma pode ter dia próprio)
    const lote = (intent.tarefas ?? [])
      .map((x) => ({ titulo: tituloValido(x?.titulo), data: dataValida(x?.data) }))
      .filter((x) => x.titulo);
    if (lote.length > 1) {
      for (const x of lote) criarTarefa(x.titulo, x.data);
      const linhas = lote
        .map((x) => `• ${x.titulo} — ${x.data === hojeStr() ? t('task.today.word') : dataCurta(x.data)}`)
        .join('\n');
      return t('task.created.multi', { n: lote.length, lines: linhas, list: formatarTarefas() ?? '—' });
    }

    const unica = lote[0] ?? { titulo: tituloValido(intent.titulo), data: dataValida(intent.data) };
    if (!unica.titulo) {
      pendencias.set(key, { fase: 'tarefa_texto', data: unica.data, criadoEm: Date.now() });
      return t('task.ask.what', { date: dataCurta(unica.data) });
    }
    return criarTarefaMsg(unica.titulo, unica.data);
  }

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
    diaCitado: extrairDiaSemanaCitado(texto),
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

// a pergunta de prazo do follow-up não pode sequestrar um pedido novo:
// mensagem longa que não é uma resposta válida descarta a pendência e segue normal
const pareceResposta = (t2) => ehSim(t2) || ehNao(t2) || /^\d{1,2}\b/.test(t2.trim());

async function responderPendencia(texto, pend, auth, key) {
  if (pend.fase === 'followup_dias' && texto.trim().length > 12 && !pareceResposta(texto)) {
    pendencias.delete(key);
    return conduzirConversa(texto, auth, key);
  }
  if (pend.fase === 'followup_dias') return responderFollowupDias(texto, pend, key);
  if (pend.fase === 'rec_slots') return responderRecSlots(texto, pend, key);
  if (pend.fase === 'rec_confirma') return responderRecConfirma(texto, pend, key);
  if (pend.fase === 'tarefa_texto') return responderTarefaTexto(texto, pend, key);
  if (pend.fase === 'orc_cliente') return responderOrcCliente(texto, pend, key);

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
  const diaCitado = extrairDiaSemanaCitado(texto);
  if (diaCitado != null) pend.diaCitado = diaCitado;
  const intent = await interpretar(texto, pend.dados);
  if (intent) mesclar(pend.dados, intent);
  return avancar(pend, auth, key);
}

const dataValida = (data) => (/^\d{4}-\d{2}-\d{2}$/.test(data ?? '') ? data : hojeStr());

// rejeita títulos vazios ou placeholders inventados pelo modelo
function tituloValido(titulo) {
  const s = (titulo ?? '').trim();
  if (!s || /^<?\s*(unknown|null|undefined|n\/a|tarefa|task)\s*>?$/i.test(s)) return null;
  return s;
}

function criarTarefaMsg(titulo, data) {
  criarTarefa(titulo, data);
  const lista = formatarTarefas();
  if (data !== hojeStr()) {
    return t('task.created.date', { text: titulo, date: dataCurta(data), list: lista });
  }
  return t('task.created', { text: titulo, list: lista, n: tarefasDoDia().length });
}

function responderTarefaTexto(texto, pend, key) {
  if (ehNao(texto)) {
    pendencias.delete(key);
    return t('discard.generic');
  }
  const titulo = tituloValido(texto);
  if (!titulo) return t('task.ask.what', { date: dataCurta(pend.data) }); // pendência continua
  pendencias.delete(key);
  return criarTarefaMsg(titulo, pend.data);
}

// todas as palavras relevantes da busca aparecem no texto? ("gravação hugo" acha "Gravação com o Hugo")
function contemPalavras(textoAlvo, busca) {
  const alvo = textoAlvo.toLowerCase();
  const palavras = busca.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  return palavras.length > 0 && palavras.every((w) => alvo.includes(w));
}

async function concluirPorNome(busca, auth) {
  const hojePendentes = pendentesDoDia();

  // "feito"/"ok" sem dizer o quê: resolve sozinho se só há uma pendência
  if (!busca) {
    if (hojePendentes.length === 1) {
      marcarFeitaPorId(hojePendentes[0].id);
      return t('task.done', { text: hojePendentes[0].texto, list: formatarTarefas() });
    }
    const lista = formatarTarefas();
    return lista ? t('done.which', { list: lista }) : t('done.nonepending');
  }

  // 1) tarefas pendentes (hoje, por palavras; depois qualquer dia, por trecho)
  const tarefa = hojePendentes.find((x) => contemPalavras(x.texto, busca)) ?? buscarPendentePorTexto(busca)[0];
  if (tarefa) {
    marcarFeitaPorId(tarefa.id);
    return t('task.done', { text: tarefa.texto, list: formatarTarefas() });
  }

  // 2) eventos de hoje na agenda
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const amanha = new Date(hoje.getTime() + 24 * 60 * 60 * 1000);
  const evento = (await listarEventos(auth, hoje, amanha))
    .find((e) => !(e.summary ?? '').startsWith('✅') && contemPalavras(e.summary ?? '', busca));
  if (evento) {
    await renomearEvento(auth, evento, `✅ ${evento.summary}`);
    return t('checkdia.markeddone', { title: evento.summary });
  }

  return t('done.notfound', { q: busca });
}

function responderOrcCliente(texto, pend, key) {
  if (ehNao(texto)) {
    pendencias.delete(key);
    return t('discard.generic');
  }
  const cliente = tituloValido(texto);
  if (!cliente) return t('orc.ask.client');
  pendencias.set(key, {
    fase: 'followup_dias',
    cliente,
    dataEnvio: new Date().toISOString(),
    criadoEm: Date.now(),
  });
  return t('orc.registered', { client: cliente });
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

    // corrige data cujo dia da semana não bate com o que o usuário citou
    const notaDia = corrigirDiaSemana(pend);
    // aviso de dia sobrecarregado
    const aviso = await avisoSobrecarga(auth, d);
    pend.sobrecarga = Boolean(aviso);
    pend.fase = 'confirma';
    const vars = {
      title: d.titulo,
      start: fmtDataHora.format(new Date(d.inicio)),
      end: fmtHora.format(new Date(d.fim)),
    };
    const base = aviso ? t('confirm.create.overload', { ...vars, warn: aviso }) : t('confirm.create', vars);
    return base + notaDia;
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
    const notaDia = corrigirDiaSemana(pend);
    return t('confirm.reschedule', {
      title: d.evento.summary,
      from: fmtDataHora.format(dataDoEvento(d.evento)),
      to: fmtDataHora.format(new Date(d.inicio)),
    }) + notaDia;
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

