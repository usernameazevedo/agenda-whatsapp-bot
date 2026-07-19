// Copie este arquivo para src/config.js e preencha com seus dados.
export const CONFIG = {
  // Número que vai RECEBER as mensagens (código do país + DDD + número)
  destinatario: process.env.WHATSAPP_TO ?? '5511999998888',

  // Idioma do bot / bot language: 'pt-BR' ou 'en'
  idioma: process.env.BOT_LANG ?? 'pt-BR',

  // Fuso horário dos agendamentos
  timezone: 'America/Sao_Paulo',

  // Horários de envio (formato cron: minuto hora * * dia-da-semana)
  cronDiario: '0 7 * * *',    // resumo do dia, todo dia às 07:00
  cronSemanal: '0 7 * * 1',   // resumo da semana, segunda às 07:00
  cronNoturno: '0 21 * * *',  // prévia de amanhã, todo dia às 21:00

  // Lembretes antes de cada compromisso (em minutos). Ex.: [15] ou [30, 10]
  lembreteMinutos: [15],

  // Aviso de dia sobrecarregado: horas máximas de compromissos por dia
  limiteHorasDia: Number(process.env.DAILY_HOURS_LIMIT ?? 6),

  // Horário da pergunta de follow-up de orçamentos
  cronFollowup: '0 9 * * *',

  // Checagem de fim de dia dos lembretes (feito ou posterga)
  cronCheckDia: '0 20 * * *',

  // Follow-up pós-reunião (pergunta como foi a reunião do dia)
  cronReunioes: '0 18 * * 1-5',

  // Nome do grupo do WhatsApp para onde o bot manda tudo (gera notificação,
  // ao contrário da conversa consigo mesmo). Crie um grupo só seu com esse
  // nome. Deixe null para usar a conversa consigo mesmo.
  grupo: process.env.WHATSAPP_GRUPO ?? null,

  // IDs extras de chat autorizados (formato novo @lid do WhatsApp).
  // Deixe vazio; se suas mensagens forem ignoradas, o log mostra o ID a adicionar.
  chatsExtras: [],

  // Número da secretária/assistente (opcional — deixe null para desativar)
  secretaria: null,
  // IDs de chat da secretária (formato antigo @c.us e novo @lid)
  secretariaChats: [],

  // IDs dos calendários a incluir ('primary' = principal).
  // Envie "agendas" no WhatsApp para ver os IDs disponíveis.
  calendarios: ['primary'],
};
