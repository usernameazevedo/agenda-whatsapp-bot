// Agente com tool use: interpreta frases livres podendo consultar a agenda
// (listar eventos, buscar por título, horários livres) antes de decidir a ação.
// Devolve a mesma intenção estruturada que conversa.js já consome, ou uma
// resposta direta em texto (campo "resposta") para perguntas de consulta.
// Ativa somente se ANTHROPIC_API_KEY estiver definida; em erro, o chamador
// deve cair no interpretar() clássico de ia.js.
import { CONFIG } from './config.js';
import { buscarEventoPorTitulo, listarEventos } from './calendar.js';
import { LOCALE, fmtDataHora, fmtHora } from './i18n.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_RODADAS = 6;

export const agenteDisponivel = Boolean(API_KEY);

const SYSTEM_PT = `Você é o assistente de agenda do usuário (Google Calendar) via WhatsApp. Data/hora atual: {AGORA} (America/Sao_Paulo, offset -03:00). Horários sempre em ISO8601 com -03:00.

Você tem ferramentas para CONSULTAR a agenda (listar eventos, buscar evento por título, horários livres). Use-as quando precisar de informação real antes de decidir — ex.: "remarca X para o primeiro horário livre de sexta" exige buscar X e consultar os horários livres de sexta. Não chute: consulte.

Ao terminar, chame SEMPRE a ferramenta "concluir" exatamente uma vez com o resultado:
- Pedido de criar/cancelar/remarcar: acao correspondente + campos preenchidos. Você NÃO executa nada; o sistema pedirá confirmação ao usuário.
- Pergunta sobre a agenda que você já respondeu consultando as ferramentas (disponibilidade, "quando é X?", conflitos): acao "responder" + campo "resposta" com o texto pronto para o WhatsApp (curto, com • para listas).
- "o que tenho hoje/amanhã/na semana?" simples: acao "resumo" + periodo (o sistema formata).
- Lembrete mensal fixo ("pagar cartão dia 10 de todo mês"): recorrente true + diaDoMes + titulo.
- Coisa a fazer SEM horário definido ("tenho que ligar pro João", "preciso mandar o documento"): acao "tarefa" + titulo curto começando com verbo. Vai para a lista de tarefas do dia, não para a agenda. Se o usuário disser o DIA ("amanhã", "dia 14/7", "sexta"), preencha "data" com YYYY-MM-DD; sem dia dito, data null (= hoje). Se ele NÃO disse qual é a tarefa (ex.: só "tarefa dia 14/7"), deixe titulo null — NUNCA invente ou use placeholder. VÁRIAS tarefas numa frase só ("tenho que ligar pro X, tirar cópia e levar o cachorro no vet amanhã") => acao "tarefa" com a lista em "tarefas" [{titulo, data}], uma entrada por tarefa; a data dita vale só para a tarefa a que se refere (as demais ficam null = hoje). ACRESCENTAR informação a uma tarefa já existente ("na tarefa do João, o número é 9999", "coloca mais informações na tarefa X: horário 14h, local escritório, cliente Riani") => acao "tarefa_nota" com busca = trecho que identifica a tarefa. Se ele der horário/local/cliente/detalhes, preencha "campos" {horario, local, cliente, detalhes} (só os ditos); informação solta que não é nenhum desses vai em "nota". NUNCA pergunte pelos campos na criação da tarefa — eles só existem quando o usuário pede para acrescentar.
- "me lembra de X" COM dia/horário definido => acao agendar com lembrete true. Reuniões/consultas => lembrete false.
- NUNCA invente horário que o usuário não disse — exceto quando ele pediu explicitamente para você escolher (ex.: "no primeiro horário livre"), aí consulte horarios_livres e use o slot real.
- Usuário AVISA que concluiu algo ("Gravação Hugo, feito", "feito a gravação", "ok, mandei o documento", "já liguei pro João") => acao "concluir" com busca = nome da coisa concluída (curto). Só "feito"/"ok" sem dizer o quê => acao "concluir" com busca null.
- Usuário AVISA que enviou um orçamento/proposta ("orçamento do Lucas enviado", "mandei o orçamento pra Riani", "orçamento Lucas ok") => acao "orcamento_enviado" com titulo = nome do cliente. Sem cliente identificável, titulo null.
- Mensagem que não é sobre agenda: acao "nada".`;

const SYSTEM_EN = `You are the user's calendar assistant (Google Calendar) on WhatsApp. Current date/time: {AGORA} (America/Sao_Paulo, offset -03:00). Always output times in ISO8601 with -03:00.

You have tools to QUERY the calendar (list events, search by title, free slots). Use them whenever you need real information before deciding — e.g. "move X to Friday's first free morning slot" requires searching X and checking Friday's free slots. Don't guess: query.

When done, ALWAYS call the "concluir" tool exactly once:
- Create/cancel/reschedule requests: matching acao + filled fields. You do NOT execute anything; the system asks the user to confirm.
- Calendar questions you answered via tools (availability, "when is X?", conflicts): acao "responder" + "resposta" with the WhatsApp-ready text (short, • for lists).
- Simple "what do I have today/tomorrow/this week?": acao "resumo" + periodo.
- Fixed monthly reminder: recorrente true + diaDoMes + titulo.
- To-do WITHOUT a set time ("I have to call John", "I need to send the document"): acao "tarefa" + short verb-first titulo. Goes to the day's task list, not the calendar. If the user names a DAY ("tomorrow", "on 7/14", "Friday"), fill "data" with YYYY-MM-DD; no day mentioned, data null (= today). If they did NOT say what the task is (e.g. just "task on 7/14"), leave titulo null — NEVER invent or use a placeholder. SEVERAL tasks in one phrase ("I have to call X, copy the doc and take the dog to the vet tomorrow") => acao "tarefa" with the list in "tarefas" [{titulo, data}], one entry per task; a stated day applies only to the task it refers to (others null = today). ADDING info to an existing task ("on the John task, the number is 9999", "add more info to task X: time 2pm, place office, client Riani") => acao "tarefa_nota" with busca = snippet identifying the task. If they give time/place/client/details, fill "campos" {horario, local, cliente, detalhes} (only what was said); loose info that fits none goes in "nota". NEVER ask for these fields at task creation — they only exist when the user asks to add info.
- "remind me to X" WITH a set day/time => acao agendar with lembrete true. Meetings/appointments => lembrete false.
- NEVER invent a time the user didn't say — unless they explicitly asked you to pick (e.g. "first free slot"); then use horarios_livres and pick a real slot.
- User REPORTS finishing something ("Hugo recording, done", "already called John") => acao "concluir" with busca = the finished thing (short). Bare "done"/"ok" => acao "concluir", busca null.
- User REPORTS having sent a quote ("Lucas quote sent", "sent the proposal to Riani") => acao "orcamento_enviado" with titulo = client name. No identifiable client, titulo null.
- Not about the calendar: acao "nada".`;

const TOOLS = [
  {
    name: 'listar_eventos',
    description: 'Lista os eventos da agenda entre duas datas (máx. 14 dias). Use para ver o que existe num dia/período.',
    input_schema: {
      type: 'object',
      properties: {
        inicio: { type: 'string', description: 'Data/hora inicial, ISO8601 (ex.: 2026-07-17T00:00:00-03:00)' },
        fim: { type: 'string', description: 'Data/hora final, ISO8601' },
      },
      required: ['inicio', 'fim'],
    },
  },
  {
    name: 'buscar_evento',
    description: 'Busca eventos futuros (próximos 30 dias) cujo título contém o termo. Use para localizar o evento que o usuário quer cancelar/remarcar.',
    input_schema: {
      type: 'object',
      properties: { termo: { type: 'string', description: 'Trecho do título do evento' } },
      required: ['termo'],
    },
  },
  {
    name: 'horarios_livres',
    description: 'Retorna os horários livres (blocos ≥30min, entre 08:00 e 22:00) de um dia específico.',
    input_schema: {
      type: 'object',
      properties: { dia: { type: 'string', description: 'O dia, formato YYYY-MM-DD' } },
      required: ['dia'],
    },
  },
  {
    name: 'concluir',
    description: 'Entrega o resultado final. Chame exatamente uma vez, ao terminar.',
    input_schema: {
      type: 'object',
      properties: {
        acao: { type: 'string', enum: ['agendar', 'cancelar', 'remarcar', 'resumo', 'livre', 'tarefa', 'tarefa_nota', 'orcamento_enviado', 'concluir', 'responder', 'nada'] },
        titulo: { type: ['string', 'null'] },
        busca: { type: ['string', 'null'], description: 'Termo para localizar o evento (cancelar/remarcar)' },
        inicio: { type: ['string', 'null'], description: 'ISO8601 com -03:00' },
        fim: { type: ['string', 'null'] },
        periodo: { type: ['string', 'null'], enum: ['hoje', 'amanha', 'semana', null] },
        lembrete: { type: 'boolean' },
        recorrente: { type: 'boolean' },
        diaDoMes: { type: ['number', 'null'] },
        data: { type: ['string', 'null'], description: 'Dia da tarefa, YYYY-MM-DD (apenas acao "tarefa"; null = hoje)' },
        tarefas: {
          type: ['array', 'null'],
          description: 'Várias tarefas numa mensagem só (apenas acao "tarefa")',
          items: {
            type: 'object',
            properties: {
              titulo: { type: 'string' },
              data: { type: ['string', 'null'], description: 'YYYY-MM-DD; null = hoje' },
            },
            required: ['titulo'],
          },
        },
        resposta: { type: ['string', 'null'], description: 'Texto pronto para o usuário (apenas acao "responder")' },
        nota: { type: ['string', 'null'], description: 'Informação a acrescentar (apenas acao "tarefa_nota"; busca identifica a tarefa)' },
        campos: {
          type: ['object', 'null'],
          description: 'Campos estruturados da tarefa (apenas acao "tarefa_nota"; preencha só o que foi dito)',
          properties: {
            horario: { type: ['string', 'null'] },
            local: { type: ['string', 'null'] },
            cliente: { type: ['string', 'null'] },
            detalhes: { type: ['string', 'null'] },
          },
        },
      },
      required: ['acao'],
    },
  },
];

// ─── execução das ferramentas ────────────────────────────────────────────────

const linhaEvento = (e) => {
  const ini = e.start?.dateTime ? new Date(e.start.dateTime) : null;
  const fim = e.end?.dateTime ? new Date(e.end.dateTime) : null;
  if (!ini) return `• ${e.summary} (dia inteiro ${e.start?.date})`;
  return `• ${e.summary} — ${fmtDataHora.format(ini)}${fim ? `–${fmtHora.format(fim)}` : ''}`;
};

async function executarFerramenta(nome, input, auth) {
  if (nome === 'listar_eventos') {
    const ini = new Date(input.inicio);
    let fim = new Date(input.fim);
    if (fim - ini > 14 * 24 * 3600 * 1000) fim = new Date(ini.getTime() + 14 * 24 * 3600 * 1000);
    const eventos = await listarEventos(auth, ini, fim);
    return eventos.length ? eventos.map(linhaEvento).join('\n') : 'Nenhum evento no período.';
  }
  if (nome === 'buscar_evento') {
    const achados = await buscarEventoPorTitulo(auth, input.termo, 30);
    return achados.length
      ? achados.slice(0, 8).map(linhaEvento).join('\n')
      : `Nenhum evento futuro com "${input.termo}".`;
  }
  if (nome === 'horarios_livres') {
    const diaIni = new Date(`${input.dia}T00:00:00-03:00`);
    const diaFim = new Date(diaIni.getTime() + 24 * 3600 * 1000);
    const eventos = (await listarEventos(auth, diaIni, diaFim))
      .filter((e) => e.start?.dateTime && e.end?.dateTime)
      .sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));
    const abertura = new Date(`${input.dia}T08:00:00-03:00`);
    const fechamento = new Date(`${input.dia}T22:00:00-03:00`);
    let cursor = abertura;
    const livres = [];
    for (const e of eventos) {
      const ini = new Date(e.start.dateTime);
      const fim = new Date(e.end.dateTime);
      if (ini - cursor >= 30 * 60 * 1000) livres.push([new Date(cursor), ini]);
      if (fim > cursor) cursor = fim;
    }
    if (fechamento - cursor >= 30 * 60 * 1000) livres.push([new Date(cursor), fechamento]);
    return livres.length
      ? livres.map(([a, b]) => `• ${fmtHora.format(a)} – ${fmtHora.format(b)}`).join('\n')
      : 'Dia sem horários livres entre 08:00 e 22:00.';
  }
  return `Ferramenta desconhecida: ${nome}`;
}

// ─── loop agêntico ───────────────────────────────────────────────────────────

async function chamarAPI(body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API Claude retornou ${res.status}`);
  return res.json();
}

// Interpreta a mensagem podendo consultar a agenda. Retorna a intenção
// (mesmo formato de ia.interpretar, mais acao "responder" + resposta),
// ou null se a IA está desativada.
export async function interpretarComAgente(texto, auth, contexto = []) {
  if (!API_KEY) return null;

  const system = (LOCALE === 'en' ? SYSTEM_EN : SYSTEM_PT).replace(
    '{AGORA}',
    new Date().toLocaleString(LOCALE === 'en' ? 'en-US' : 'pt-BR', { timeZone: 'America/Sao_Paulo' })
  );
  // mensagens recentes do usuário como contexto — a atual pode referenciá-las
  // ("marca o dentista com essas informações" após encaminhar uma confirmação)
  const conteudo = contexto.length
    ? `Mensagens anteriores do usuário nesta conversa (da mais antiga à mais recente; a mensagem atual pode se referir a elas):\n${contexto.map((c) => `- ${c}`).join('\n')}\n\nMensagem atual: ${texto}`
    : texto;
  const messages = [{ role: 'user', content: conteudo }];

  for (let rodada = 0; rodada < MAX_RODADAS; rodada++) {
    const data = await chamarAPI({
      model: MODEL,
      max_tokens: 1000,
      system,
      tools: TOOLS,
      // na última rodada força a conclusão para não estourar o limite
      tool_choice: rodada === MAX_RODADAS - 1 ? { type: 'tool', name: 'concluir' } : { type: 'auto' },
      messages,
    });

    const chamadas = (data.content ?? []).filter((b) => b.type === 'tool_use');
    const conclusao = chamadas.find((c) => c.name === 'concluir');
    if (conclusao) return conclusao.input;

    if (data.stop_reason !== 'tool_use' || chamadas.length === 0) {
      // terminou em texto sem concluir — pede a conclusão estruturada
      messages.push({ role: 'assistant', content: data.content });
      messages.push({ role: 'user', content: 'Chame a ferramenta "concluir" agora com o resultado.' });
      const final = await chamarAPI({
        model: MODEL,
        max_tokens: 1000,
        system,
        tools: TOOLS,
        tool_choice: { type: 'tool', name: 'concluir' },
        messages,
      });
      const c = (final.content ?? []).find((b) => b.type === 'tool_use' && b.name === 'concluir');
      return c ? c.input : { acao: 'nada' };
    }

    messages.push({ role: 'assistant', content: data.content });
    const resultados = [];
    for (const chamada of chamadas) {
      let conteudo;
      try {
        conteudo = await executarFerramenta(chamada.name, chamada.input, auth);
      } catch (err) {
        resultados.push({ type: 'tool_result', tool_use_id: chamada.id, content: `Erro: ${err.message}`, is_error: true });
        continue;
      }
      resultados.push({ type: 'tool_result', tool_use_id: chamada.id, content: conteudo });
    }
    messages.push({ role: 'user', content: resultados });
  }

  return { acao: 'nada' };
}
