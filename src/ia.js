// Interpretação de linguagem natural via API do Claude (opcional).
// Ativa somente se ANTHROPIC_API_KEY estiver definida.
const API_KEY = process.env.ANTHROPIC_API_KEY;

export const iaDisponivel = Boolean(API_KEY);

const SYSTEM = `Você preenche um formulário de agenda a partir de mensagens em português. Data/hora atual: {AGORA} (America/Sao_Paulo, offset -03:00).
{PENDENTE}
Responda APENAS o JSON, sem explicação:
{"acao":"agendar|cancelar|remarcar|resumo|livre|nada","titulo":string|null,"busca":string|null,"inicio":"ISO8601 com -03:00"|null,"fim":"ISO8601"|null,"periodo":"hoje"|"amanha"|"semana"|null,"lembrete":boolean,"recorrente":boolean,"diaDoMes":number|null,"checkFrase":string|null}

Regras:
- Lembretes que se repetem TODO MÊS num dia fixo (ex.: "pagar o cartão dia 10 de todo mês", "todo dia 5 me lembra de X", "lembrete mensal") => recorrente true, diaDoMes = número do dia (1-31), titulo = a tarefa (curto). Deixe inicio/fim null.
- "me lembra de X", "lembrete: X", tarefas a fazer (SEM repetição mensal) => acao agendar com titulo X e lembrete true. Reuniões/encontros/consultas => lembrete false.
- "cancela/desmarca X" => acao cancelar com busca X.
- "muda/altera/remarca/joga X para <quando>" => acao remarcar com busca X e inicio novo.
- Perguntas sobre a agenda ("o que tenho hoje?") => acao resumo com periodo.
- Se houver formulário pendente, a mensagem do usuário provavelmente responde a ele: preserve os campos já preenchidos e complete apenas com a informação nova (ex.: "15h" preenche inicio; "termina 16h" preenche fim; "1h" ou "meia hora" define fim a partir do inicio).
- NUNCA invente horário que o usuário não disse. Se não foi dito, deixe null.
- acao "nada" apenas quando a mensagem claramente não é sobre agenda.`;

// Geração de texto livre (ex.: rascunho de mensagem de cobrança)
export async function gerarTexto(instrucao) {
  if (!API_KEY) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: instrucao }],
    }),
  });
  if (!res.ok) throw new Error(`API Claude retornou ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text ?? null;
}

export async function interpretar(texto, pendente = null) {
  if (!API_KEY) return null;
  const contextoPendente = pendente
    ? `Formulário pendente (o usuário está no meio deste fluxo): ${JSON.stringify(pendente)}`
    : 'Sem formulário pendente.';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: SYSTEM
        .replace('{AGORA}', new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }))
        .replace('{PENDENTE}', contextoPendente),
      messages: [{ role: 'user', content: texto }],
    }),
  });
  if (!res.ok) throw new Error(`API Claude retornou ${res.status}`);
  const data = await res.json();
  const raw = data.content?.[0]?.text ?? '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { acao: 'nada' };
  try {
    return JSON.parse(match[0]);
  } catch {
    return { acao: 'nada' };
  }
}
