import { CONFIG } from './config.js';
import { listarCalendarios, listarEventos } from './calendar.js';
import { resumoDiario, resumoSemanal } from './formatar.js';
import { iaDisponivel } from './ia.js';
import { conduzirConversa, temPendencia, dispararCheckDia, iniciarRecorrente } from './conversa.js';
import { tentarCheck, listarRecorrentes, removerRecorrente } from './recorrentes.js';

const fmtHora = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: CONFIG.timezone,
});

const MANUAL = `👋 *Bem-vindo ao seu assistente de agenda!*

Fala comigo em linguagem natural — sem comandos decorados. Tudo que altera a agenda pede sua confirmação com *S* ou *N* antes de executar.

━━━━━━━━━━━━━━━
📌 *MARCAR*
Escreva o que, quando e a hora:
• _marca reunião com o cliente quinta às 15h_
• _ensaio de fotos dia 15, das 14h às 17h_
• _me lembra de pagar o boleto amanhã_
Sem hora de fim? Assumo *1h* de duração.
Sem hora? Eu pergunto.

🔁 *REMARCAR*
• _muda a gravação de quinta pra sexta de manhã_
• _joga o dentista pra semana que vem_
Se houver mais de um parecido, mostro uma lista numerada — responda *1*, *2*...

🗑 *CANCELAR*
• _cancela o ensaio de sexta_
• _desmarca a reunião com o Lukas_

🔁 *LEMBRETE MENSAL INSISTENTE*
Para contas e tarefas fixas do mês. Escreva *mensal* (ou já mande completo):
• _pagar cartão dia 10_
Aviso *2 dias antes* (1x), *1 dia antes* (2x) e *no dia* de hora em hora.
Para parar, é só mandar *"paguei"* ou *"feito cartão"*.
• *recorrentes* — lista os ativos · _remover recorrente 1_ — apaga

👀 *CONSULTAR* (responde na hora, sem confirmação)
• *hoje* — agenda de hoje
• *amanhã* — agenda de amanhã
• *semana* — visão da semana
• *livre* — horários vagos de hoje
• _o que tenho quinta?_ — também funciona em frase

━━━━━━━━━━━━━━━
⚙️ *RECURSOS AUTOMÁTICOS*
• 07:00 — resumo do dia
• Segunda 07:00 — resumo da semana
• 21:00 — prévia de amanhã
• 15 min antes — lembrete de cada reunião com link
• 20:00 — checagem: pergunto se cada lembrete foi feito (*N* = joga pra amanhã)
• Orçamentos — ao marcar "enviar orçamento", ofereço cobrar o retorno sozinho

━━━━━━━━━━━━━━━
🔧 *OUTROS COMANDOS*
• *checagem* — roda a checagem do dia agora
• *agendas* — lista seus calendários
• *start* ou *ajuda* — mostra este manual

Dica: nas confirmações, responda só *S* ou *N*. 😉`;


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
      if (quitado) return `✅ Anotado: *${quitado.titulo}* feito. Volto a te lembrar no próximo mês.`;
    }

    if (lower === 'start' || lower === 'manual' || lower === 'menu' || lower === 'ajuda' || lower === 'help') return MANUAL;
    if (lower === 'mensal' || lower === 'lembrete mensal' || lower === 'novo mensal') return iniciarRecorrente(origem);
    if (lower === 'recorrentes' && origem === 'self') return listarRecorrentesMsg();
    if (lower.startsWith('remover recorrente') && origem === 'self') return removerRecorrenteMsg(msg);
    if (lower === 'hoje') return resumo('hoje', auth);
    if (lower === 'amanhã' || lower === 'amanha') return resumo('amanha', auth);
    if (lower === 'semana') return resumo('semana', auth);
    if (lower === 'livre' || lower === 'livre?') return horariosLivres(auth);
    if (lower === 'agendas') return listarAgendas(auth);
    if (lower === 'checagem' && origem === 'self') {
      return (await dispararCheckDia(auth)) ?? 'Nenhum lembrete pendente hoje. ✅';
    }
  }

  if (!iaDisponivel) {
    return '🤖 O modo de conversa precisa da chave da API configurada. Use os comandos: *hoje*, *semana*, *livre*, *ajuda*.';
  }

  const resultado = await conduzirConversa(msg, auth, origem);

  // a IA identificou um pedido de resumo no meio da frase
  if (resultado && typeof resultado === 'object' && resultado.atalho) {
    const { periodo } = resultado.atalho;
    if (resultado.atalho.acao === 'livre') return horariosLivres(auth);
    return resumo(periodo ?? 'hoje', auth);
  }

  if (typeof resultado === 'string') return resultado;

  return '🤔 Recebi sua mensagem, mas não identifiquei um pedido de agenda. Digite *ajuda* para ver o que sei fazer.';
}

async function resumo(periodo, auth) {
  if (periodo === 'semana') {
    const { inicio, fim } = janela(7);
    return resumoSemanal(await listarEventos(auth, inicio, fim), inicio);
  }
  if (periodo === 'amanha') {
    const { inicio, fim } = janela(1, 1);
    return resumoDiario(await listarEventos(auth, inicio, fim), inicio, '🌅 *Sua agenda de amanhã*');
  }
  const { inicio, fim } = janela(1);
  return resumoDiario(await listarEventos(auth, inicio, fim), inicio);
}

async function horariosLivres(auth) {
  const agora = new Date();
  const fimDia = new Date(agora);
  fimDia.setHours(22, 0, 0, 0);
  if (agora >= fimDia) return '🌙 O dia já acabou — amanhã tem mais!';

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

  if (livres.length === 0) return '😅 Dia cheio — nenhum intervalo de 30 min ou mais até as 22h.';
  const linhas = livres.map(([a, b]) => `• ${fmtHora.format(a)} – ${fmtHora.format(b)}`).join('\n');
  return `🕓 *Horários livres hoje:*\n${linhas}`;
}

function listarRecorrentesMsg() {
  const lista = listarRecorrentes();
  if (lista.length === 0) return 'Nenhum lembrete recorrente ativo. Crie dizendo algo como: _pagar o cartão dia 10 de todo mês, me avisa até eu mandar "paguei"_.';
  const linhas = lista
    .map((r, i) => `(${i + 1}) *${r.titulo}* — todo dia ${r.diaDoMes}`)
    .join('\n');
  return `🔁 *Lembretes recorrentes:*\n${linhas}\n\nPara apagar: _remover recorrente 1_`;
}

function removerRecorrenteMsg(msg) {
  const n = parseInt(msg.match(/\d+/)?.[0] ?? '', 10);
  const lista = listarRecorrentes();
  if (!n || !lista[n - 1]) return 'Número inválido. Manda *recorrentes* para ver a lista.';
  const alvo = lista[n - 1];
  removerRecorrente(alvo.id);
  return `✅ Removido: *${alvo.titulo}* (todo dia ${alvo.diaDoMes}).`;
}

async function listarAgendas(auth) {
  const cals = await listarCalendarios(auth);
  const linhas = cals
    .map((c) => `• ${c.summary}${CONFIG.calendarios.includes(c.id) ? ' ✅' : ''}\n   \`${c.id}\``)
    .join('\n');
  return `📚 *Seus calendários* (✅ = incluído nos resumos):\n${linhas}\n\nPara incluir outro, adicione o ID em src/config.js.`;
}
