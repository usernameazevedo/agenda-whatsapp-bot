import { CONFIG } from './config.js';
import { listarCalendarios, listarEventos } from './calendar.js';
import { resumoDiario, resumoSemanal } from './formatar.js';
import { iaDisponivel } from './ia.js';
import { conduzirConversa, temPendencia, dispararCheckDia } from './conversa.js';

const fmtHora = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: CONFIG.timezone,
});

const AJUDA = `🤖 *Como me usar* (fala normal comigo!):

• _"marca dentista quinta às 15h"_
• _"me lembra de pagar o boleto amanhã"_
• _"muda o horário da reunião com o Lukas"_
• _"cancela o dentista"_

Sempre vou conferir data, início e fim com você e pedir confirmação antes de mexer na agenda.

*Comandos rápidos:*
• *hoje* / *amanhã* / *semana* — resumos
• *livre* — horários vagos de hoje
• *agendas* — seus calendários
• *ajuda* — esta mensagem`;

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
    if (lower === 'ajuda' || lower === 'help') return AJUDA;
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

async function listarAgendas(auth) {
  const cals = await listarCalendarios(auth);
  const linhas = cals
    .map((c) => `• ${c.summary}${CONFIG.calendarios.includes(c.id) ? ' ✅' : ''}\n   \`${c.id}\``)
    .join('\n');
  return `📚 *Seus calendários* (✅ = incluído nos resumos):\n${linhas}\n\nPara incluir outro, adicione o ID em src/config.js.`;
}
