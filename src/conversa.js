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

const PENDENCIA_TTL_MIN = 10;
const DURACAO_PADRAO_MIN = 60;
const REGEX_ORCAMENTO = /or[çc]ament|proposta/i;

// usuário único: uma pendência global cobre qualquer formato de chat (@c.us / @lid)
const DEFAULT_KEY = 'self';
const pendencias = new Map();

const fmtDataHora = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: CONFIG.timezone,
});
const fmtHora = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: CONFIG.timezone,
});
const fmtDia = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  timeZone: CONFIG.timezone,
});

const dataDoEvento = (e) => new Date(e.start?.dateTime ?? `${e.start?.date}T12:00:00`);
const linhaCandidato = (e, i) => `(${i + 1}) ${e.summary} — ${fmtDataHora.format(dataDoEvento(e))}`;

const ehSim = (t) => /^(s|sim|pode|ok|isso|confirmo|confirmar)\b/i.test(t.trim());
const ehNao = (t) => /^(n|n[ãa]o|deixa|cancela)\b/i.test(t.trim());

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

  if (ehNao(texto)) {
    pendencias.delete(key);
    if (pend.fase === 'confirma' && pend.sobrecarga) {
      return '❌ Não criei. Se quiser, manda "livre" para ver horários vagos de hoje, ou me diz outro dia.';
    }
    return '❌ Ok, descartado. Nada foi alterado na agenda.';
  }

  if (pend.fase === 'confirma' && ehSim(texto)) {
    pendencias.delete(key);
    return executar(pend, auth, key);
  }

  if (pend.fase === 'escolha') {
    const escolhido = escolherCandidato(texto, pend.candidatos);
    if (!escolhido) return 'Responde com o número da opção, ex.: 1';
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
    else return 'Responde (1) marcar novo, (2) alterar o existente ou (3) cancelar o existente.';
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
    if (!d.titulo) { pend.fase = 'slots'; return 'O que você quer marcar? (título do compromisso)'; }
    if (!d.inicio) { pend.fase = 'slots'; return `"${d.titulo}" — que dia e que horas começa?`; }
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
        const lista = pend.candidatos.map(linhaCandidato).join('\n');
        return `Já existe na agenda:\n${lista}\n\n(1) Marcar um novo mesmo assim\n(2) Alterar o existente para o novo horário\n(3) Cancelar o existente`;
      }
    }

    // aviso de dia sobrecarregado
    const aviso = await avisoSobrecarga(auth, d);
    pend.sobrecarga = Boolean(aviso);
    pend.fase = 'confirma';
    const resumo = `Marcar "${d.titulo}" — ${fmtDataHora.format(new Date(d.inicio))} até ${fmtHora.format(new Date(d.fim))}.`;
    return aviso ? `${resumo}\n${aviso} Confirma mesmo assim? (S/N)` : `${resumo} (S/N)`;
  }

  if (pend.acao === 'cancelar' || pend.acao === 'remarcar') {
    const d = pend.dados;
    if (!d.evento) {
      const busca = d.busca ?? d.titulo;
      if (!busca) { pend.fase = 'slots'; return 'Qual compromisso? (me diz o nome dele)'; }
      const achados = await buscarEventoPorTitulo(auth, busca, 30);
      if (achados.length === 0) {
        pendencias.delete(key);
        return `Não achei nenhum compromisso com "${busca}" nos próximos 30 dias. Manda "semana" para ver o que tem.`;
      }
      if (achados.length > 1) {
        pend.candidatos = achados.slice(0, 5);
        pend.fase = 'escolha';
        const lista = pend.candidatos.map(linhaCandidato).join('\n');
        return `Qual deles?\n${lista}`;
      }
      d.evento = achados[0];
    }

    if (pend.acao === 'remarcar' && !d.inicio) {
      pend.fase = 'slots';
      return `"${d.evento.summary}" (${fmtDataHora.format(dataDoEvento(d.evento))}) — mudar para que dia e horário?`;
    }

    pend.fase = 'confirma';
    if (pend.acao === 'cancelar') {
      return `Cancelar "${d.evento.summary}" — ${fmtDataHora.format(dataDoEvento(d.evento))}. (S/N)`;
    }
    return `Alterar "${d.evento.summary}" de ${fmtDataHora.format(dataDoEvento(d.evento))} para ${fmtDataHora.format(new Date(d.inicio))}. (S/N)`;
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
  return `Atenção: ${fmtDia.format(inicio)} já está com ${horasOcupadas}h ocupadas (${eventos.length} compromisso${eventos.length > 1 ? 's' : ''}).`;
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
    let msg = `✅ Agendado: ${d.titulo} — ${fmtDataHora.format(inicio)}\n${evento.htmlLink ?? ''}`;

    // follow-up automático de orçamento
    if (REGEX_ORCAMENTO.test(d.titulo)) {
      pendencias.set(key, {
        fase: 'followup_dias',
        cliente: d.titulo,
        dataEnvio: inicio.toISOString(),
        criadoEm: Date.now(),
      });
      msg += '\n\nQuer que eu cobre retorno automaticamente se não houver resposta? Em quantos dias? (responda um número, ou N para não)';
    }
    return msg;
  }
  if (pend.acao === 'cancelar') {
    await deletarEvento(auth, d.evento);
    return `✅ Cancelado: ${d.evento.summary}`;
  }
  if (pend.acao === 'remarcar') {
    await remarcarEvento(auth, d.evento, new Date(d.inicio));
    return `✅ Remarcado: ${d.evento.summary} → ${fmtDataHora.format(new Date(d.inicio))}`;
  }
  return null;
}

// ─── follow-up de orçamento ──────────────────────────────────────────────────

function responderFollowupDias(texto, pend, key) {
  if (ehNao(texto)) {
    pendencias.delete(key);
    return 'Ok, sem cobrança automática.';
  }
  const n = parseInt(texto.trim().match(/\d+/)?.[0] ?? '', 10);
  if (!n || n < 1 || n > 90) return 'Responde com o número de dias (ex.: 3), ou N para não cobrar.';
  criarFollowup({ cliente: pend.cliente, dataEnvio: pend.dataEnvio, prazoDias: n });
  pendencias.delete(key);
  return `✅ Combinado. Em ${n} dia${n > 1 ? 's' : ''} eu pergunto se houve retorno.`;
}

async function responderFollowupResposta(texto, pend, auth, key) {
  if (ehSim(texto)) {
    atualizarFollowup(pend.followupId, { status: 'respondido' });
    pendencias.delete(key);
    return '✅ Ótimo, follow-up encerrado.';
  }
  if (ehNao(texto)) {
    atualizarFollowup(pend.followupId, { status: 'cobrar' });
    const inicio = new Date();
    inicio.setMinutes(0, 0, 0);
    inicio.setHours(inicio.getHours() + 1);
    const fim = new Date(inicio.getTime() + 30 * 60 * 1000);
    await criarEvento(auth, { titulo: `Cobrar retorno: ${pend.cliente}`, inicio, fim });
    pend.fase = 'followup_texto';
    pend.criadoEm = Date.now();
    pendencias.set(key, pend);
    return `✅ Criei um lembrete de cobrança para hoje às ${fmtHora.format(inicio)}.\nQuer que eu sugira um texto de cobrança? (S/N)`;
  }
  return `Houve retorno sobre "${pend.cliente}"? Responde S ou N.`;
}

async function responderFollowupTexto(texto, pend, key) {
  pendencias.delete(key);
  if (!ehSim(texto)) return 'Ok.';
  const sugestao = await gerarTexto(
    `Escreva uma mensagem curta e educada de WhatsApp, em português do Brasil, cobrando gentilmente o retorno de um cliente sobre este orçamento enviado: "${pend.cliente}". Tom profissional e direto, sem assinatura. Responda apenas o texto da mensagem.`
  );
  return sugestao ? `Sugestão de texto:\n\n${sugestao}` : 'Não consegui gerar o texto agora, tenta de novo mais tarde.';
}

// ─── checagem de fim de dia dos lembretes ────────────────────────────────────

const ehLembrete = (e) =>
  e.extendedProperties?.private?.agendaBot === 'lembrete' ||
  /lembrete|lembrar|cobrar/i.test(e.summary ?? '');

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
  return `Checagem do dia (${fila.length} lembrete${fila.length > 1 ? 's' : ''}):\n"${fila[0].summary}" foi feito? (S/N — N posterga para amanhã)`;
}

async function responderCheckDia(texto, pend, auth, key) {
  const evento = pend.fila[pend.idx];
  let resultado;
  if (ehSim(texto)) {
    await renomearEvento(auth, evento, `✅ ${evento.summary}`);
    resultado = `✅ "${evento.summary}" marcado como feito.`;
  } else if (ehNao(texto)) {
    const novoInicio = new Date(dataDoEvento(evento).getTime() + 24 * 60 * 60 * 1000);
    await remarcarEvento(auth, evento, novoInicio);
    resultado = `✅ "${evento.summary}" postergado para ${fmtDataHora.format(novoInicio)}.`;
  } else {
    return `"${evento.summary}" foi feito? Responde S ou N.`;
  }

  pend.idx += 1;
  if (pend.idx >= pend.fila.length) {
    pendencias.delete(key);
    return `${resultado}\nChecagem do dia concluída.`;
  }
  pend.criadoEm = Date.now();
  pendencias.set(key, pend);
  const proximo = pend.fila[pend.idx];
  return `${resultado}\n\n"${proximo.summary}" foi feito? (S/N)`;
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
  await enviar(`Já teve retorno sobre "${devido.cliente}"? (S/N)`);
}
