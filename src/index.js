import cron from 'node-cron';
import qrcode from 'qrcode-terminal';
import pkg from 'whatsapp-web.js';
import { CONFIG } from './config.js';
import { getAuthClient, listarEventos } from './calendar.js';
import { resumoDiario, resumoSemanal } from './formatar.js';
import { processarComando } from './comandos.js';
import { dispararCobrancas, dispararCheckDia } from './conversa.js';
import { lembretesParaAgora } from './recorrentes.js';
import { verificarLembretes } from './lembretes.js';
import { notificarMac, registrarErroGoogle, registrarSucessoGoogle } from './saude.js';
import { t } from './i18n.js';

const { Client, LocalAuth } = pkg;

const whatsapp = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox'],
  },
});

whatsapp.on('qr', async (qr) => {
  aguardandoQr = true;
  console.log('Escaneie o QR code abaixo com o WhatsApp (Aparelhos conectados):\n');
  qrcode.generate(qr, { small: true });
  try {
    const QRCode = (await import('qrcode')).default;
    await QRCode.toFile('qr.png', qr, { width: 400 });
    console.log('QR também salvo em qr.png');
  } catch (err) {
    console.error('Falha ao salvar qr.png:', err.message);
  }
  notificarMac('Agenda WhatsApp', t('notif.qr'));
});

// hora atual (0-23) no fuso configurado
function horaAgora() {
  const s = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: CONFIG.timezone,
  }).format(new Date());
  return Number(s) % 24;
}

function inicioDoDia(data, offsetDias = 0) {
  const d = new Date(data);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDias);
  return d;
}

// marcador invisível no início de toda mensagem do bot (evita processar a si mesmo)
const MARCA_BOT = '​';

async function enviarPara(chatId, texto) {
  await whatsapp.sendMessage(chatId, MARCA_BOT + texto);
  console.log(`[${new Date().toISOString()}] Bot respondeu: ${texto.slice(0, 100).replace(/\n/g, ' | ')}`);
}

async function enviarMensagem(texto) {
  await enviarPara(`${CONFIG.destinatario}@c.us`, texto);
}

async function comSaude(fn) {
  try {
    await fn();
    registrarSucessoGoogle();
  } catch (err) {
    registrarErroGoogle(err);
  }
}

async function executarDiario(auth) {
  const hoje = inicioDoDia(new Date());
  const eventos = await listarEventos(auth, hoje, inicioDoDia(new Date(), 1));
  await enviarMensagem(resumoDiario(eventos, hoje));
}

async function executarSemanal(auth) {
  const hoje = inicioDoDia(new Date());
  const eventos = await listarEventos(auth, hoje, inicioDoDia(new Date(), 7));
  await enviarMensagem(resumoSemanal(eventos, hoje));
}

async function executarNoturno(auth) {
  const amanha = inicioDoDia(new Date(), 1);
  const eventos = await listarEventos(auth, amanha, inicioDoDia(new Date(), 2));
  await enviarMensagem(resumoDiario(eventos, amanha, t('daily.title.preview')));
}

// ─── watchdog de autocura ────────────────────────────────────────────────────
// O pm2 reinicia o processo quando ele MORRE; este watchdog garante que ele
// morra (para renascer limpo via start.sh) quando estiver vivo porém travado.
const WATCHDOG = {
  limiteConexaoMin: 4,   // tempo máximo para conectar após iniciar
  intervaloCheckMin: 5,  // frequência da checagem de saúde
  falhasParaReiniciar: 2,
};
let conectado = false;
let falhasSeguidas = 0;
let aguardandoQr = false; // sessão expirada: precisa de ação humana, reiniciar não resolve

async function reiniciarLimpo(motivo) {
  console.error(`[watchdog] ${motivo} — reiniciando para recuperar.`);
  notificarMac('Agenda WhatsApp', t('notif.recover', { r: motivo }));
  try {
    await whatsapp.destroy();
  } catch {}
  process.exit(1); // pm2 reinicia; start.sh limpa Chrome órfão e locks
}

// camada 1: travou na inicialização (nunca conectou)
setTimeout(() => {
  if (!conectado && !aguardandoQr) reiniciarLimpo(`não conectou em ${WATCHDOG.limiteConexaoMin} min`);
}, WATCHDOG.limiteConexaoMin * 60 * 1000);

// camada 2: checagem periódica do estado da conexão
setInterval(async () => {
  if (!conectado) return;
  const estado = await whatsapp.getState().catch(() => null);
  if (estado === 'CONNECTED') {
    falhasSeguidas = 0;
    return;
  }
  falhasSeguidas += 1;
  console.warn(`[watchdog] estado=${estado} (falha ${falhasSeguidas}/${WATCHDOG.falhasParaReiniciar})`);
  if (falhasSeguidas >= WATCHDOG.falhasParaReiniciar) {
    reiniciarLimpo(`conexão perdida (estado: ${estado})`);
  }
}, WATCHDOG.intervaloCheckMin * 60 * 1000);

async function main() {
  const auth = await getAuthClient();

  whatsapp.on('ready', async () => {
    conectado = true;
    aguardandoQr = false;
    falhasSeguidas = 0;
    console.log('WhatsApp conectado.');

    const modoTeste = process.argv.indexOf('--now');
    if (modoTeste !== -1) {
      const tipo = process.argv[modoTeste + 1];
      try {
        if (tipo === 'weekly') await executarSemanal(auth);
        else if (tipo === 'night') await executarNoturno(auth);
        else await executarDiario(auth);
      } catch (err) {
        console.error('Erro no envio de teste:', err.message);
      }
      setTimeout(() => process.exit(0), 3000);
      return;
    }

    const opts = { timezone: CONFIG.timezone };
    cron.schedule(CONFIG.cronDiario, () => comSaude(() => executarDiario(auth)), opts);
    cron.schedule(CONFIG.cronSemanal, () => comSaude(() => executarSemanal(auth)), opts);
    cron.schedule(CONFIG.cronNoturno, () => comSaude(() => executarNoturno(auth)), opts);
    cron.schedule('* * * * *', () => comSaude(() => verificarLembretes(auth, enviarMensagem)), opts);
    cron.schedule(CONFIG.cronFollowup, () => comSaude(() => dispararCobrancas(enviarMensagem)), opts);
    cron.schedule(CONFIG.cronCheckDia, () => comSaude(async () => {
      const pergunta = await dispararCheckDia(auth);
      if (pergunta) await enviarMensagem(pergunta);
    }), opts);
    // lembretes recorrentes insistentes: verifica no início de cada hora
    cron.schedule('0 * * * *', () => comSaude(async () => {
      const hora = horaAgora();
      for (const msg of lembretesParaAgora(hora)) await enviarMensagem(msg);
    }), opts);

    console.log(`Agendado: diário (${CONFIG.cronDiario}), semanal (${CONFIG.cronSemanal}), noturno (${CONFIG.cronNoturno}), lembretes ${CONFIG.lembreteMinutos.join('/')}min antes — ${CONFIG.timezone}`);

    const chatsAutorizados = new Set([
      `${CONFIG.destinatario}@c.us`,
      ...(CONFIG.chatsExtras ?? []),
    ]);
    const PREFIXOS_BOT = ['✅', '🤖', '❓', '☀️', '🗓', '🌙', '🌅', '🔔', '🗑', '🔁', '🕓', '📚', '😅', '🤔', '👋', '📝', '🕐', '📋', '⚠️', '👍', '📌', '⏰', '🚨'];
    whatsapp.on('message_create', async (msg) => {
      try {
        const chat = await msg.getChat();
        if (!msg.body || msg.body.startsWith(MARCA_BOT) || PREFIXOS_BOT.some((p) => msg.body.startsWith(p))) return;

        // conversa "com você mesmo" (formato antigo @c.us ou novo @lid)
        const isConversaPropria = msg.from === msg.to || chatsAutorizados.has(chat.id._serialized);

        // conversa direta com a secretária: só mensagens DELA (não as suas)
        let isSecretaria = false;
        if (!isConversaPropria && !msg.fromMe && !chat.isGroup && CONFIG.secretaria) {
          isSecretaria = (CONFIG.secretariaChats ?? []).includes(chat.id._serialized);
          if (!isSecretaria) {
            const contato = await msg.getContact().catch(() => null);
            isSecretaria = contato?.number === CONFIG.secretaria || msg.from === `${CONFIG.secretaria}@c.us`;
          }
        }

        if (!isConversaPropria && !isSecretaria) {
          console.log(`[msg ignorada] chat=${chat.id._serialized} from=${msg.from} to=${msg.to}`);
          return;
        }

        const origem = isConversaPropria ? 'self' : `sec:${chat.id._serialized}`;
        console.log(`[${new Date().toISOString()}] Mensagem recebida (${origem}): ${msg.body.slice(0, 60)}`);
        const resposta = await processarComando(msg.body, auth, origem);
        if (resposta) {
          await enviarPara(chat.id._serialized, resposta);
          // avisa o dono quando a secretária conclui uma ação na agenda
          if (origem !== 'self' && resposta.startsWith('✅')) {
            await enviarMensagem(t('secretary.notice', { msg: resposta.split('\n')[0] }));
          }
        }
      } catch (err) {
        console.error('Erro ao processar comando:', err.message);
        try {
          const chat = await msg.getChat();
          await enviarPara(chat.id._serialized, t('err.exec', { err: err.message }));
        } catch {}
      }
    });
    console.log('Comandos via WhatsApp ativos (envie "ajuda" na conversa com você mesmo).');
  });

  whatsapp.on('auth_failure', (msg) => {
    console.error('Falha de autenticação no WhatsApp:', msg);
    notificarMac('Agenda WhatsApp', t('notif.authfail'));
  });
  // camada 3: desconexão explícita → reinício limpo imediato
  whatsapp.on('disconnected', (reason) => {
    console.error('WhatsApp desconectado:', reason);
    conectado = false;
    reiniciarLimpo(`WhatsApp desconectou (${reason})`);
  });

  await whatsapp.initialize();
}

// desligamento gracioso: fecha o Chrome antes de sair (evita corromper a sessão)
for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, async () => {
    console.log(`Recebido ${sinal}, encerrando...`);
    try {
      await whatsapp.destroy();
    } catch {}
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Erro fatal:', err.message);
  notificarMac('Agenda WhatsApp', `Serviço parou: ${err.message}`);
  process.exit(1);
});
