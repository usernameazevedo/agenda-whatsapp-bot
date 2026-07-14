// Camada de idioma (i18n). Escolha em CONFIG.idioma ('pt-BR' ou 'en').
// t(chave, vars) devolve o texto no idioma configurado, com {var} interpolado.
import { CONFIG } from './config.js';

export const LOCALE = CONFIG.idioma === 'en' ? 'en' : 'pt-BR';
const intlLocale = LOCALE === 'en' ? 'en-US' : 'pt-BR';
const use12h = LOCALE === 'en';

// ─── formatadores de data/hora no idioma certo ───────────────────────────────
const horaDigitos = use12h ? 'numeric' : '2-digit';
export const fmtHora = new Intl.DateTimeFormat(intlLocale, {
  hour: horaDigitos, minute: '2-digit', hour12: use12h, timeZone: CONFIG.timezone,
});
export const fmtDataHora = new Intl.DateTimeFormat(intlLocale, {
  weekday: 'short', day: '2-digit', month: '2-digit',
  hour: horaDigitos, minute: '2-digit', hour12: use12h, timeZone: CONFIG.timezone,
});
export const fmtDia = new Intl.DateTimeFormat(intlLocale, {
  weekday: 'long', day: '2-digit', month: '2-digit', timeZone: CONFIG.timezone,
});
export const fmtDiaSemana = fmtDia;

export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ─── detecção de sim/não (aceita os dois idiomas, é mais tolerante) ───────────
export const ehSim = (t) => /^(s|sim|pode|isso|confirmo|confirmar|y|yes|yep|yup|ok|okay|sure|confirm)\b/i.test(t.trim());
export const ehNao = (t) => /^(n|n[ãa]o|deixa|cancela|no|nope|cancel|nvm|nevermind)\b/i.test(t.trim());

// verbos de conclusão para dar baixa em lembrete recorrente (pt + en)
export const PALAVRAS_FEITO = new Set([
  'feito', 'feita', 'fiz', 'paguei', 'pago', 'paga', 'pagei', 'pronto',
  'resolvi', 'resolvido', 'mandei', 'enviei', 'enviado', 'concluido',
  'concluida', 'conclui', 'ok', 'done', 'quitado', 'quitei', 'terminei',
  'paid', 'sent', 'finished', 'resolved', 'completed', 'complete',
]);

// palavras-chave de comando aceitas (une pt + en para ser tolerante)
export const CMD = {
  manual: ['start', 'manual', 'menu', 'ajuda', 'help'],
  mensal: ['mensal', 'lembrete mensal', 'novo mensal', 'monthly', 'monthly reminder'],
  recorrentes: ['recorrentes', 'recurring'],
  removerRec: ['remover recorrente', 'remove recurring'],
  hoje: ['hoje', 'today'],
  amanha: ['amanhã', 'amanha', 'tomorrow'],
  semana: ['semana', 'week'],
  livre: ['livre', 'livre?', 'free', 'free?'],
  agendas: ['agendas', 'calendars'],
  checagem: ['checagem', 'check'],
  reunioes: ['reuniões', 'reunioes', 'meetings'],
  tarefas: ['tarefas', 'tarefas de hoje', 'tasks', 'todo', 'to-do'],
};

const DICT = {
  'pt-BR': {
    // formatar
    'daily.title.morning': '☀️ *Bom dia! Sua agenda de hoje*',
    'daily.title.tomorrow': '🌅 *Sua agenda de amanhã*',
    'daily.title.preview': '🌙 *Prévia de amanhã*',
    'event.untitled': '(sem título)',
    'event.allday': '(dia inteiro)',
    'daily.empty': '{title} ({day}): agenda livre, nenhum compromisso. 🎉',
    'daily.total': 'Total: {n} compromisso(s).',
    'daily.sec.birthdays': '*🎂 Aniversários*',
    'daily.sec.events': '*📅 Compromissos*',
    'daily.sec.reminders': '*🔔 Lembretes*',
    'daily.sec.tasks': '*📝 Tarefas do dia*',
    'daily.sec.tasks.hint': '_Para dar baixa: "1. feito"_',

    // tarefas
    'task.created': '✅ Tarefa anotada para hoje: *{text}*\n\n📝 *Tarefas do dia:*\n{list}\n\n_Dê baixa com "{n}. feito"_',
    'task.created.date': '✅ Tarefa anotada para {date}: *{text}*\n\n📝 *Tarefas de {date}:*\n{list}\n\n_Ela aparece no resumo desse dia._',
    'task.ask.what': 'Qual é a tarefa de {date}? (ou N para cancelar)',
    'task.created.multi': '✅ {n} tarefas anotadas:\n{lines}\n\n📝 *Tarefas de hoje:*\n{list}\n\n_Dê baixa com "1. feito"_',
    'task.today.word': 'hoje',
    'audio.heard': '🎤 Entendi: _"{text}"_',
    'audio.fail': '🎤 Não consegui transcrever esse áudio. Tenta de novo ou manda por texto.',
    'task.done': '✅ Feita: *{text}*\n\n📝 *Tarefas do dia:*\n{list}',
    'task.done.badnum': 'Não achei a tarefa nº {n} de hoje. Manda *tarefas* para ver a lista numerada.',
    'task.list.today': '📝 *Tarefas de hoje ({date}):*\n{list}\n\n_Dê baixa com "1. feito"_',
    'task.list.date': '📝 *Tarefas do dia {date}:*\n{list}',
    'task.list.empty': 'Nenhuma tarefa anotada em {date}.',
    'task.list.baddate': 'Não entendi a data. Ex.: *tarefas do dia 01/7*',
    'task.postponed.tag': '_(postergada p/ o dia seguinte)_',
    'task.postponed.auto': '📌 {n} tarefa(s) pendente(s) foram postergadas para hoje.',
    'task.checkdia.postponed': '❌ "{title}" fica pendente e passa automaticamente para amanhã.',
    'week.empty': '🗓️ *Resumo da semana*\n\nSemana livre, nenhum compromisso agendado. 🎉',
    'week.title': '🗓️ *Resumo da semana* ({n} compromissos):',
    'week.birthdays': '*🎉 Aniversários da semana:*',
    'reminder.in': '🔔 *{title}* em {min} min ({time}){loc}{link}',
    'reminder.join': 'Entrar: ',

    // confirmações genéricas
    'discard.overload': '❌ Não criei. Se quiser, manda "livre" para ver horários vagos de hoje, ou me diz outro dia.',
    'discard.generic': '❌ Ok, descartado. Nada foi alterado na agenda.',
    'ask.option.number': 'Responde com o número da opção, ex.: 1',
    'ask.op.123': 'Responde (1) marcar novo, (2) alterar o existente ou (3) cancelar o existente.',

    // agendar
    'ask.what': 'O que você quer marcar? (título do compromisso)',
    'ask.when': '"{title}" — que dia e que horas começa?',
    'conflict.header': 'Já existe na agenda:\n{list}\n\n(1) Marcar um novo mesmo assim\n(2) Alterar o existente para o novo horário\n(3) Cancelar o existente',
    'confirm.create': 'Marcar "{title}" — {start} até {end}. (S/N)',
    'confirm.create.overload': 'Marcar "{title}" — {start} até {end}.\n{warn} Confirma mesmo assim? (S/N)',
    'overload.warn': 'Atenção: {day} já está com {hours}h ocupadas ({n} compromisso{s}).',

    // cancelar/remarcar
    'ask.which': 'Qual compromisso? (me diz o nome dele)',
    'notfound': 'Não achei nenhum compromisso com "{q}" nos próximos 30 dias. Manda "semana" para ver o que tem.',
    'ask.whichone': 'Qual deles?\n{list}',
    'ask.newtime': '"{title}" ({when}) — mudar para que dia e horário?',
    'confirm.cancel': 'Cancelar "{title}" — {when}. (S/N)',
    'confirm.reschedule': 'Alterar "{title}" de {from} para {to}. (S/N)',

    // execução
    'done.created': '✅ Agendado: {title} — {when}\n{link}',
    'done.canceled': '✅ Cancelado: {title}',
    'done.rescheduled': '✅ Remarcado: {title} → {when}',
    'followup.offer': '\n\nQuer que eu cobre retorno automaticamente se não houver resposta? Em quantos dias? (responda um número, ou N para não)',

    // follow-up
    'followup.no': 'Ok, sem cobrança automática.',
    'followup.askdays': 'Responde com o número de dias (ex.: 3), ou N para não cobrar.',
    'followup.set': '✅ Combinado. Em {n} dia{s} eu pergunto se houve retorno.',
    'followup.closed': '✅ Ótimo, follow-up encerrado.',
    'followup.reminderset': '✅ Criei um lembrete de cobrança para hoje às {time}.\nQuer que eu sugira um texto de cobrança? (S/N)',
    'followup.askreturn': 'Houve retorno sobre "{client}"? Responde S ou N.',
    'followup.ok': 'Ok.',
    'followup.draft': 'Sugestão de texto:\n\n{text}',
    'followup.draftfail': 'Não consegui gerar o texto agora, tenta de novo mais tarde.',
    'followup.chase.title': 'Cobrar retorno: {client}',
    'followup.due': 'Já teve retorno sobre "{client}"? (S/N)',
    'ia.chase.prompt': 'Escreva uma mensagem curta e educada de WhatsApp, em português do Brasil, cobrando gentilmente o retorno de um cliente sobre este orçamento enviado: "{client}". Tom profissional e direto, sem assinatura. Responda apenas o texto da mensagem.',

    // recorrentes (criação)
    'rec.ask.both': 'O que lembrar e em que dia do mês? (ex.: _pagar cartão dia 10_)',
    'rec.ask.title': 'E o que você quer lembrar nesse dia?',
    'rec.ask.day': '"{title}" — em que dia do mês? (1 a 31)',
    'rec.confirm': 'Lembrete mensal todo dia {day}: *{title}*.\nInsisto 2 dias antes, 1 dia antes e no dia até você mandar "paguei"/"feito". (S/N)',
    'rec.badday': 'Me diz um dia do mês entre 1 e 31.',
    'rec.discard': '❌ Ok, descartado. Nenhum lembrete recorrente criado.',
    'rec.created': '✅ Lembrete mensal criado: *{title}*, todo dia {day}.',
    'rec.ask.confirm': 'Responde S para confirmar ou N para descartar.',

    // recorrentes (mensagens de disparo)
    'rec.msg.2d': '📌 Lembrete: faltam 2 dias para *{title}* (dia {day}).',
    'rec.msg.1d': '⏰ *{title}* é amanhã (dia {day}). Não esquece!',
    'rec.msg.0d': '🚨 HOJE é dia de *{title}*!\nQuando fizer, me manda "paguei" ou "feito" que eu paro de avisar.',
    'rec.check.done': '✅ Anotado: *{title}* feito. Volto a te lembrar no próximo mês.',
    'rec.list.empty': 'Nenhum lembrete recorrente ativo. Crie dizendo algo como: _pagar cartão dia 10_.',
    'rec.list.day': 'todo dia {day}',
    'rec.list.header': '🔁 *Lembretes recorrentes:*\n{list}\n\nPara apagar: _remover recorrente 1_',
    'rec.remove.bad': 'Número inválido. Manda *recorrentes* para ver a lista.',
    'rec.removed': '✅ Removido: *{title}* (todo dia {day}).',

    // follow-up de reuniões (fim do dia)
    'reu.entrega': '📋 Reunião "{title}": ficou algo pra entregar? (1) sim (2) não',
    'reu.tipo': 'O que ficou? (1) orçamento (2) marcar fotógrafo/filmmaker (3) outros',
    'reu.outros': 'Escreve o que foi:',
    'reu.ask12': 'Responde 1 (sim) ou 2 (não).',
    'reu.ask123': 'Responde 1, 2 ou 3.',
    'reu.created': '✅ Anotei "{task}" para {day}.',
    'reu.finished': 'Follow-up das reuniões concluído. ✅',
    'reu.none': 'Nenhuma reunião hoje. ✅',
    'reu.task.orcamento': 'Orçamento — {meeting}',
    'reu.task.foto': 'Marcar fotógrafo/filmmaker — {meeting}',
    'reu.task.outros': '{text} — {meeting}',

    // checagem de fim de dia
    'checkdia.start': 'Checagem do dia ({n} lembrete{s}):\n"{title}" foi feito? (S/N — N posterga para amanhã)',
    'checkdia.markeddone': '✅ "{title}" marcado como feito.',
    'checkdia.postponed': '✅ "{title}" postergado para {when}.',
    'checkdia.ask': '"{title}" foi feito? Responde S ou N.',
    'checkdia.finished': '{result}\nChecagem do dia concluída.',
    'checkdia.next': '{result}\n\n"{title}" foi feito? (S/N)',
    'checkdia.none': 'Nenhum lembrete pendente hoje. ✅',

    // comandos gerais
    'no.ai': '🤖 O modo de conversa precisa da chave da API configurada. Use os comandos: *hoje*, *semana*, *livre*, *ajuda*.',
    'not.understood': '🤔 Recebi sua mensagem, mas não identifiquei um pedido de agenda. Digite *ajuda* para ver o que sei fazer.',
    'free.dayover': '🌙 O dia já acabou — amanhã tem mais!',
    'free.full': '😅 Dia cheio — nenhum intervalo de 30 min ou mais até as 22h.',
    'free.header': '🕓 *Horários livres hoje:*\n{lines}',
    'calendars.header': '📚 *Seus calendários* (✅ = incluído nos resumos):\n{list}\n\nPara incluir outro, adicione o ID em src/config.js.',
    'err.exec': '❌ Deu erro ao executar: {err}. Tenta de novo ou reformula.',
    'secretary.notice': 'Secretária: {msg}',

    // notificações do macOS
    'notif.qr': 'Sessão expirou — precisa escanear o QR de novo (qr.png na pasta do projeto).',
    'notif.authfail': 'Falha de autenticação no WhatsApp — verifique o agenda.log.',
    'notif.disconnected': 'WhatsApp desconectado ({r}). O serviço vai tentar reconectar.',
    'notif.recover': 'Auto-recuperação: {r}',
    'notif.google': 'O Google Calendar está falhando há 3 tentativas. Verifique o agenda.log.',

    'manual': `👋 *Bem-vindo ao seu assistente de agenda!*

Fala comigo em linguagem natural — sem comandos decorados. Tudo que altera a agenda pede sua confirmação com *S* ou *N* antes de executar.

━━━━━━━━━━━━━━━
📌 *MARCAR*
Escreva o que, quando e a hora:
• _marca reunião com o cliente quinta às 15h_
• _me lembra de pagar o boleto amanhã_
Sem hora de fim? Assumo *1h* de duração.

🔁 *REMARCAR* / 🗑 *CANCELAR*
• _muda a gravação de quinta pra sexta_
• _cancela o dentista_

🔁 *LEMBRETE MENSAL INSISTENTE*
Para contas fixas do mês. Escreva *mensal* ou já mande completo:
• _pagar cartão dia 10_
Aviso 2 dias antes, 1 dia antes e no dia de hora em hora.
Para parar: mande *"paguei"* ou *"feito cartão"*.
• *recorrentes* — lista · _remover recorrente 1_ — apaga

📝 *TAREFAS DO DIA*
Fale a tarefa sem hora que ela entra na lista de hoje:
• _tenho que ligar pro João_ · _preciso mandar o contrato_
• *tarefas* — lista de hoje · *"1. feito"* — dá o check ✅
• _tarefas do dia 01/7_ — histórico com ✅/❌
Não feita no dia? Ganha ❌ e passa sozinha para o dia seguinte.

👀 *CONSULTAR* (sem confirmação)
• *hoje* · *amanhã* · *semana* · *livre*

⚙️ *AUTOMÁTICO*: resumo 07:00, semana seg 07:00, follow-up de reuniões 19:00, checagem 20:00, prévia 21:00, lembrete 15min antes.

🔧 *OUTROS*: *reuniões* · *checagem* · *agendas* · *start* (este manual)

Dica: nas confirmações, responda só *S* ou *N*. 😉`,
  },

  en: {
    'daily.title.morning': '☀️ *Good morning! Your agenda for today*',
    'daily.title.tomorrow': '🌅 *Your agenda for tomorrow*',
    'daily.title.preview': "🌙 *Tomorrow's preview*",
    'event.untitled': '(untitled)',
    'event.allday': '(all day)',
    'daily.empty': '{title} ({day}): all clear, nothing scheduled. 🎉',
    'daily.total': 'Total: {n} event(s).',
    'daily.sec.birthdays': '*🎂 Birthdays*',
    'daily.sec.events': '*📅 Events*',
    'daily.sec.reminders': '*🔔 Reminders*',
    'daily.sec.tasks': '*📝 Today\'s tasks*',
    'daily.sec.tasks.hint': '_To check off: "1. done"_',

    // tasks
    'task.created': '✅ Task noted for today: *{text}*\n\n📝 *Today\'s tasks:*\n{list}\n\n_Check off with "{n}. done"_',
    'task.created.date': "✅ Task noted for {date}: *{text}*\n\n📝 *Tasks for {date}:*\n{list}\n\n_It shows up in that day's summary._",
    'task.ask.what': "What's the task for {date}? (or N to cancel)",
    'task.created.multi': '✅ {n} tasks noted:\n{lines}\n\n📝 *Today\'s tasks:*\n{list}\n\n_Check off with "1. done"_',
    'task.today.word': 'today',
    'audio.heard': '🎤 I heard: _"{text}"_',
    'audio.fail': "🎤 Couldn't transcribe that voice note. Try again or send it as text.",
    'task.done': '✅ Done: *{text}*\n\n📝 *Today\'s tasks:*\n{list}',
    'task.done.badnum': "Couldn't find today's task #{n}. Send *tasks* to see the numbered list.",
    'task.list.today': "📝 *Today's tasks ({date}):*\n{list}\n\n_Check off with \"1. done\"_",
    'task.list.date': '📝 *Tasks for {date}:*\n{list}',
    'task.list.empty': 'No tasks noted on {date}.',
    'task.list.baddate': "Couldn't parse the date. E.g.: *tasks 07/01*",
    'task.postponed.tag': '_(moved to the next day)_',
    'task.postponed.auto': '📌 {n} pending task(s) were moved to today.',
    'task.checkdia.postponed': '❌ "{title}" stays pending and automatically moves to tomorrow.',
    'week.empty': '🗓️ *Week summary*\n\nClear week, nothing scheduled. 🎉',
    'week.title': '🗓️ *Week summary* ({n} events):',
    'week.birthdays': '*🎉 Birthdays this week:*',
    'reminder.in': '🔔 *{title}* in {min} min ({time}){loc}{link}',
    'reminder.join': 'Join: ',

    'discard.overload': "❌ Didn't create it. Send \"free\" to see today's open slots, or tell me another day.",
    'discard.generic': '❌ Ok, discarded. Nothing changed in your calendar.',
    'ask.option.number': 'Reply with the option number, e.g.: 1',
    'ask.op.123': 'Reply (1) create new, (2) edit the existing one, or (3) cancel the existing one.',

    'ask.what': 'What do you want to schedule? (event title)',
    'ask.when': '"{title}" — what day and time does it start?',
    'conflict.header': 'This already exists:\n{list}\n\n(1) Create a new one anyway\n(2) Move the existing one to the new time\n(3) Cancel the existing one',
    'confirm.create': 'Create "{title}" — {start} to {end}. (Y/N)',
    'confirm.create.overload': 'Create "{title}" — {start} to {end}.\n{warn} Confirm anyway? (Y/N)',
    'overload.warn': 'Heads up: {day} already has {hours}h booked ({n} event{s}).',

    'ask.which': 'Which event? (tell me its name)',
    'notfound': 'I found no event matching "{q}" in the next 30 days. Send "week" to see what you have.',
    'ask.whichone': 'Which one?\n{list}',
    'ask.newtime': '"{title}" ({when}) — move to what day and time?',
    'confirm.cancel': 'Cancel "{title}" — {when}. (Y/N)',
    'confirm.reschedule': 'Move "{title}" from {from} to {to}. (Y/N)',

    'done.created': '✅ Scheduled: {title} — {when}\n{link}',
    'done.canceled': '✅ Canceled: {title}',
    'done.rescheduled': '✅ Rescheduled: {title} → {when}',
    'followup.offer': "\n\nWant me to chase the reply automatically if there's no response? In how many days? (reply a number, or N for no)",

    'followup.no': 'Ok, no automatic chasing.',
    'followup.askdays': 'Reply with the number of days (e.g.: 3), or N to skip.',
    'followup.set': "✅ Got it. In {n} day{s} I'll ask if you heard back.",
    'followup.closed': '✅ Great, follow-up closed.',
    'followup.reminderset': "✅ I created a chase reminder for today at {time}.\nWant me to draft a follow-up message? (Y/N)",
    'followup.askreturn': 'Did you hear back about "{client}"? Reply Y or N.',
    'followup.ok': 'Ok.',
    'followup.draft': 'Suggested message:\n\n{text}',
    'followup.draftfail': "Couldn't generate the text right now, try again later.",
    'followup.chase.title': 'Chase reply: {client}',
    'followup.due': 'Did you hear back about "{client}"? (Y/N)',
    'ia.chase.prompt': 'Write a short, polite WhatsApp message in English gently following up with a client about this quote sent: "{client}". Professional and direct tone, no signature. Reply only the message text.',

    'rec.ask.both': 'What to remind and on which day of the month? (e.g.: _pay card day 10_)',
    'rec.ask.title': 'And what do you want to be reminded of on that day?',
    'rec.ask.day': '"{title}" — on which day of the month? (1 to 31)',
    'rec.confirm': 'Monthly reminder every day {day}: *{title}*.\nI\'ll nudge 2 days before, 1 day before, and hourly on the day until you send "paid"/"done". (Y/N)',
    'rec.badday': 'Tell me a day of the month between 1 and 31.',
    'rec.discard': '❌ Ok, discarded. No recurring reminder created.',
    'rec.created': '✅ Monthly reminder created: *{title}*, every day {day}.',
    'rec.ask.confirm': 'Reply Y to confirm or N to discard.',

    'rec.msg.2d': '📌 Reminder: 2 days left for *{title}* (day {day}).',
    'rec.msg.1d': "⏰ *{title}* is tomorrow (day {day}). Don't forget!",
    'rec.msg.0d': '🚨 TODAY is the day for *{title}*!\nWhen done, send me "paid" or "done" and I\'ll stop.',
    'rec.check.done': "✅ Noted: *{title}* done. I'll remind you again next month.",
    'rec.list.empty': 'No active recurring reminders. Create one by saying: _pay card day 10_.',
    'rec.list.day': 'every day {day}',
    'rec.list.header': '🔁 *Recurring reminders:*\n{list}\n\nTo delete: _remove recurring 1_',
    'rec.remove.bad': 'Invalid number. Send *recurring* to see the list.',
    'rec.removed': '✅ Removed: *{title}* (every day {day}).',

    // meeting follow-up (end of day)
    'reu.entrega': '📋 Meeting "{title}": anything to deliver afterwards? (1) yes (2) no',
    'reu.tipo': 'What was it? (1) quote (2) book photographer/filmmaker (3) other',
    'reu.outros': 'Type what it was:',
    'reu.ask12': 'Reply 1 (yes) or 2 (no).',
    'reu.ask123': 'Reply 1, 2 or 3.',
    'reu.created': '✅ Noted "{task}" for {day}.',
    'reu.finished': 'Meeting follow-up complete. ✅',
    'reu.none': 'No meetings today. ✅',
    'reu.task.orcamento': 'Quote — {meeting}',
    'reu.task.foto': 'Book photographer/filmmaker — {meeting}',
    'reu.task.outros': '{text} — {meeting}',

    'checkdia.start': "End-of-day check ({n} reminder{s}):\nWas \"{title}\" done? (Y/N — N moves it to tomorrow)",
    'checkdia.markeddone': '✅ "{title}" marked as done.',
    'checkdia.postponed': '✅ "{title}" moved to {when}.',
    'checkdia.ask': 'Was "{title}" done? Reply Y or N.',
    'checkdia.finished': '{result}\nEnd-of-day check complete.',
    'checkdia.next': '{result}\n\nWas "{title}" done? (Y/N)',
    'checkdia.none': 'No pending reminders today. ✅',

    'no.ai': '🤖 Conversation mode needs the API key configured. Use the commands: *today*, *week*, *free*, *help*.',
    'not.understood': "🤔 Got your message, but I couldn't identify a calendar request. Type *help* to see what I can do.",
    'free.dayover': "🌙 The day is over — more tomorrow!",
    'free.full': '😅 Full day — no 30-min gap or longer until 10pm.',
    'free.header': '🕓 *Free slots today:*\n{lines}',
    'calendars.header': '📚 *Your calendars* (✅ = included in summaries):\n{list}\n\nTo include another, add its ID in src/config.js.',
    'err.exec': '❌ Something went wrong: {err}. Try again or rephrase.',
    'secretary.notice': 'Secretary: {msg}',

    'notif.qr': 'Session expired — you need to scan the QR again (qr.png in the project folder).',
    'notif.authfail': 'WhatsApp authentication failed — check agenda.log.',
    'notif.disconnected': 'WhatsApp disconnected ({r}). The service will try to reconnect.',
    'notif.recover': 'Self-recovery: {r}',
    'notif.google': 'Google Calendar has failed 3 times in a row. Check agenda.log.',

    'manual': `👋 *Welcome to your schedule assistant!*

Talk to me in plain language — no commands to memorize. Anything that changes your calendar asks for a *Y* or *N* confirmation first.

━━━━━━━━━━━━━━━
📌 *SCHEDULE*
Say what, when and the time:
• _meeting with the client Thursday 3pm_
• _remind me to pay the bill tomorrow_
No end time? I assume *1h*.

🔁 *RESCHEDULE* / 🗑 *CANCEL*
• _move the recording from Thursday to Friday_
• _cancel the dentist_

🔁 *INSISTENT MONTHLY REMINDER*
For fixed monthly bills. Type *monthly* or send it complete:
• _pay card day 10_
I nudge 2 days before, 1 day before, and hourly on the day.
To stop: send *"paid"* or *"done card"*.
• *recurring* — list · _remove recurring 1_ — delete

📝 *DAILY TASKS*
Say a task with no time and it joins today's list:
• _I have to call John_ · _I need to send the contract_
• *tasks* — today's list · *"1. done"* — checks it off ✅
• _tasks 07/01_ — history with ✅/❌
Not done today? It gets ❌ and moves itself to tomorrow.

👀 *QUERY* (no confirmation)
• *today* · *tomorrow* · *week* · *free*

⚙️ *AUTOMATIC*: summary 7am, week Mon 7am, meeting follow-up 7pm, check 8pm, preview 9pm, reminder 15min before.

🔧 *OTHER*: *meetings* · *check* · *calendars* · *start* (this manual)

Tip: on confirmations, just reply *Y* or *N*. 😉`,
  },
};

const strings = DICT[LOCALE] ?? DICT['pt-BR'];

export function t(chave, vars = {}) {
  let s = strings[chave] ?? DICT['pt-BR'][chave] ?? chave;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
