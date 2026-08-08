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

  // Nome do grupo do WhatsApp para onde o bot manda tudo (gera notificação,
  // ao contrário da conversa consigo mesmo). Crie um grupo só seu com esse
  // nome. Deixe null para usar a conversa consigo mesmo.
  grupo: process.env.WHATSAPP_GRUPO ?? null,

  // IDs extras de chat autorizados (formato novo @lid do WhatsApp).
  // Deixe vazio; se suas mensagens forem ignoradas, o log mostra o ID a adicionar.
  chatsExtras: [],

  // Número da secretária/assistente (opcional — deixe null para desativar)
  secretaria: null,
  // Primeiro nome da secretária: tarefas que citam esse nome aparecem
  // destacadas na lista do dia. null desliga o destaque.
  secretariaNome: process.env.SECRETARIA_NOME ?? null,
  // IDs de chat da secretária (formato antigo @c.us e novo @lid)
  secretariaChats: [],

  // Tarefas mensais fixas: no dia indicado, o texto entra na lista de tarefas
  // do dia (cron das 7h). Ex.: { dia: 8, texto: 'Pagar cartão' }
  tarefasMensais: [],

  // IDs dos calendários a incluir ('primary' = principal).
  // Envie "agendas" no WhatsApp para ver os IDs disponíveis.
  calendarios: ['primary'],

  // ─── Execução em servidor (opcional) ───────────────────────────────────────
  // Veja deploy/README.md. Todos podem ficar como estão para rodar localmente.

  // Caminho do Chromium. Vazio = usa o do Puppeteer. No Linux ARM é obrigatório
  // apontar para o Chromium do sistema (ex.: /usr/bin/chromium).
  chromePath: process.env.CHROME_PATH ?? null,

  // Host SSH da sua máquina pessoal, para comandos que só existem lá
  // (Claude Code, pastas de projeto). Vazio = esses comandos ficam desativados.
  macSshHost: process.env.MAC_SSH_HOST ?? null,
  macHome: process.env.MAC_HOME ?? null,

  // Tópico ntfy.sh para alertas de infraestrutura quando não há notificação
  // nativa disponível (servidor).
  ntfyTopic: process.env.NTFY_TOPIC ?? null,

  // Transcrição de áudio: vazio = descoberta automática nos caminhos padrão.
  whisperBin: process.env.WHISPER_BIN ?? null,
  whisperModelo: process.env.WHISPER_MODELO ?? null,
  ffmpegBin: process.env.FFMPEG_BIN ?? null,
};
