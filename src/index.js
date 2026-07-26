import cron from 'node-cron';
import qrcode from 'qrcode-terminal';
import pkg from 'whatsapp-web.js';
import puppeteer from 'puppeteer';
import { CONFIG } from './config.js';
import { getAuthClient, listarEventos } from './calendar.js';
import { resumoDiario, resumoSemanal } from './formatar.js';
import { processarComando } from './comandos.js';
import { lembretesParaAgora } from './recorrentes.js';
import { verificarLembretes } from './lembretes.js';
import { postergarPendentes, formatarTarefas, fechamentoDoDia, criarTarefa } from './tarefas.js';
import { paraCobrar, atualizarFollowup } from './followups.js';
import { transcreverAudio, audioDisponivel } from './audio.js';
import { interceptarBridge, gerarBriefing } from './claude-bridge.js';
import { diagnosticarAutomacoes } from './diagnostico.js';
import { verificacaoDiaria } from './verificacao.js';
import { notificarMac, registrarErroGoogle, registrarSucessoGoogle } from './saude.js';
import { t } from './i18n.js';

const { Client, LocalAuth } = pkg;

const whatsapp = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    // Chromium do Puppeteer, não o Chrome do sistema: evita que a instância
    // headless do bot bloqueie a abertura do Chrome normal no Dock
    executablePath: puppeteer.executablePath(),
    args: ['--no-sandbox'],
    // 60s: elimina "Page.navigate timed out" do padrão de 30s que causava reinícios
    protocolTimeout: 60000,
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

// id do grupo de destino (resolvido no ready); null = conversa consigo mesmo
let grupoId = null;

// compara nomes de grupo ignorando espaços, emoji, acentos e maiúsculas
const nomeNormalizado = (s) =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();

// getChats() quebrou com "Error: r" após atualização do WhatsApp Web (jul/2026);
// lê a lista de grupos direto do Store da página, sem a serialização da lib
async function listarGrupos() {
  return whatsapp.pupPage.evaluate(() =>
    window.require('WAWebCollections').Chat.getModelsArray()
      .filter((c) => c.isGroup ?? c.id?.server === 'g.us')
      .map((c) => ({ id: c.id._serialized, name: c.formattedTitle ?? c.name ?? '' }))
  );
}

async function resolverGrupo() {
  if (!CONFIG.grupo && !CONFIG.grupoId) return;
  try {
    if (CONFIG.grupo) {
      const chats = await listarGrupos();
      const alvo = nomeNormalizado(CONFIG.grupo);
      const g = chats.find((c) => c.name === CONFIG.grupo || nomeNormalizado(c.name) === alvo);
      if (g) {
        grupoId = g.id;
        console.log(`Mensagens do bot irão para o grupo "${CONFIG.grupo}" (${grupoId}).`);
        return;
      }
    }
  } catch (err) {
    console.error('Falha ao resolver grupo por nome:', err.message);
  }
  if (CONFIG.grupoId) {
    grupoId = CONFIG.grupoId;
    console.log(`Mensagens do bot irão para o grupo pelo ID fixo (${grupoId}).`);
  } else {
    console.warn(`Grupo "${CONFIG.grupo}" não encontrado — usando a conversa própria.`);
  }
}

async function enviarMensagem(texto) {
  await enviarPara(grupoId ?? `${CONFIG.destinatario}@c.us`, texto);
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
  // postergação automática: pendentes de ontem ganham ❌ no histórico e cópia hoje
  const movidas = postergarPendentes();
  // cobranças de orçamento vencidas viram linha na lista do dia (sem interrogatório)
  for (const f of paraCobrar()) {
    criarTarefa(t('followup.chase.title', { client: f.cliente }));
    atualizarFollowup(f.id, { status: 'na_lista' });
  }
  const eventos = await listarEventos(auth, hoje, inicioDoDia(new Date(), 1));
  let msg = resumoDiario(eventos, hoje, t('daily.title.morning'), formatarTarefas());
  if (movidas > 0) msg += `\n${t('task.postponed.auto', { n: movidas })}`;
  await enviarMensagem(msg);
}

async function executarSemanal(auth) {
  const hoje = inicioDoDia(new Date());
  const eventos = await listarEventos(auth, hoje, inicioDoDia(new Date(), 7));
  await enviarMensagem(resumoSemanal(eventos, hoje));
}

async function executarNoturno(auth) {
  // fechamento do dia: consolidação única com ✅ feito / ❌ não feito
  const fech = fechamentoDoDia();
  if (fech) {
    const aviso = fech.pendentes > 0
      ? t('closing.pending', { n: fech.pendentes })
      : t('closing.alldone');
    await enviarMensagem(t('closing.header', { list: fech.lista, note: aviso }));
  }
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

// registro de queda: persiste início e motivo para avisar no WhatsApp ao reconectar
const DOWNTIME = new URL('../downtime.json', import.meta.url).pathname;

function registrarQueda(motivo) {
  try {
    let reg = null;
    try { reg = JSON.parse(fs.readFileSync(DOWNTIME, 'utf8')); } catch { /* primeira queda */ }
    const agora = new Date().toISOString();
    reg = reg?.inicio
      ? { ...reg, motivo, reinicios: (reg.reinicios ?? 0) + 1 }
      : { inicio: agora, motivo, reinicios: 1 };
    fs.writeFileSync(DOWNTIME, JSON.stringify(reg, null, 1));
  } catch (err) {
    console.error('Falha ao registrar queda:', err.message);
  }
}

async function avisarRecuperacao() {
  let reg;
  try { reg = JSON.parse(fs.readFileSync(DOWNTIME, 'utf8')); } catch { return; }
  try { fs.unlinkSync(DOWNTIME); } catch {}
  if (!reg?.inicio) return;
  const fmt = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: CONFIG.timezone, hour12: false });
  const minutos = Math.max(1, Math.round((Date.now() - new Date(reg.inicio).getTime()) / 60000));
  const texto =
    `⚠️ *Bot ficou fora do ar* por ~${minutos} min\n` +
    `De ${fmt(reg.inicio)} até ${fmt(new Date().toISOString())}\n` +
    `Motivo: ${reg.motivo}${reg.reinicios > 1 ? ` (${reg.reinicios} reinícios até recuperar)` : ''}\n\n` +
    `Mensagens recebidas nesse período NÃO foram processadas — reenvie pedidos feitos nesse intervalo.`;
  try {
    await enviarMensagem(texto);
  } catch (err) {
    console.error('Falha ao enviar aviso de recuperação:', err.message);
  }
}

async function reiniciarLimpo(motivo) {
  console.error(`[watchdog] ${motivo} — reiniciando para recuperar.`);
  registrarQueda(motivo);
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


// outbox: mensagens enfileiradas por scripts externos (ex: publicar-html)
// formato: [{ "grupo": "Nome do Grupo", "texto": "..." }] ou [{ "para": "5522...", "texto": "..." }]
import fs from 'fs';
const OUTBOX = new URL('../outbox.json', import.meta.url).pathname;

let outboxOcupada = false;
let gruposCache = null;

async function processarOutbox() {
  if (outboxOcupada) return; // evita envios duplicados por execuções sobrepostas
  outboxOcupada = true;
  try {
    await processarOutboxInterno();
  } finally {
    outboxOcupada = false;
  }
}

async function processarOutboxInterno() {
  let fila;
  try {
    if (!fs.existsSync(OUTBOX)) return;
    fila = JSON.parse(fs.readFileSync(OUTBOX, 'utf8'));
  } catch { return; }
  if (!Array.isArray(fila) || fila.length === 0) return;
  // reivindica a fila imediatamente: esvazia o arquivo antes de enviar,
  // para que novas execuções não vejam os mesmos itens
  fs.writeFileSync(OUTBOX, '[]');
  const restantes = [];
  for (const item of fila) {
    try {
      let chatId;
      if (item.grupo) {
        // comparação tolerante: ignora maiúsculas, acentos, emoji e espaços
        const mesmoNome = (a, b) => nomeNormalizado(a) === nomeNormalizado(b);
        if (!gruposCache) gruposCache = await listarGrupos();
        let g = gruposCache.find((c) => mesmoNome(c.name, item.grupo));
        if (!g) { gruposCache = await listarGrupos(); g = gruposCache.find((c) => mesmoNome(c.name, item.grupo)); }
        if (!g) {
          console.error(`outbox: grupos visíveis: ${gruposCache.map((c) => c.name).join(' | ')}`);
          throw new Error(`grupo "${item.grupo}" não encontrado`);
        }
        chatId = g.id;
      } else if (item.para) {
        if (!/^\d{10,15}$/.test(String(item.para))) {
          console.error(`outbox: número inválido descartado: "${item.para}"`);
          continue;
        }
        chatId = `${item.para}@c.us`;
      } else {
        continue;
      }
      await enviarPara(chatId, item.texto);
    } catch (err) {
      console.error(`outbox: falha ao enviar [${item.grupo ?? item.para}] "${(item.texto ?? '').slice(0, 50)}": ${err.message}`);
      item.tentativas = (item.tentativas || 0) + 1;
      if (item.tentativas < 10) restantes.push(item);
    }
  }
  if (restantes.length) {
    // devolve as falhas à fila sem apagar itens que chegaram durante o envio
    let atual = [];
    try { atual = JSON.parse(fs.readFileSync(OUTBOX, 'utf8')); } catch { /* mantém vazio */ }
    fs.writeFileSync(OUTBOX, JSON.stringify([...restantes, ...atual], null, 1));
  }
}

async function main() {
  const auth = await getAuthClient();

  whatsapp.on('ready', async () => {
    conectado = true;
    aguardandoQr = false;
    falhasSeguidas = 0;
    console.log('WhatsApp conectado.');
    await resolverGrupo();
    await avisarRecuperacao();

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

    setInterval(() => processarOutbox().catch(() => {}), 30000);
    const opts = { timezone: CONFIG.timezone };
    // agendamento tolerante: expressão ausente/inválida no config.js não pode
    // derrubar o handler de ready (mataria os agendamentos seguintes e os comandos).
    // Chave ausente cai no padrão; só desativa (com aviso) se for inválida mesmo.
    const agendar = (nome, expr, padrao, fn) => {
      if (!expr && padrao) {
        console.warn(`[cron] "${nome}" sem expressão no src/config.js — usando padrão ${padrao}`);
        expr = padrao;
      }
      if (!expr || !cron.validate(expr)) {
        console.warn(`[cron] "${nome}" desativado: expressão ausente ou inválida (${expr ?? 'undefined'}) — defina no src/config.js`);
        return;
      }
      cron.schedule(expr, fn, opts);
    };
    agendar('diario', CONFIG.cronDiario, '0 7 * * *', () => comSaude(() => executarDiario(auth)));
    agendar('semanal', CONFIG.cronSemanal, '0 7 * * 1', () => comSaude(() => executarSemanal(auth)));
    agendar('noturno', CONFIG.cronNoturno, '0 21 * * *', () => comSaude(() => executarNoturno(auth)));
    agendar('lembretes', '* * * * *', null, () => comSaude(() => verificarLembretes(auth, enviarMensagem)));
    // briefing matinal inteligente (Claude analisa agenda + tarefas + followups)
    agendar('briefing', '10 7 * * 1-6', null, () => comSaude(async () => {
      const hoje = inicioDoDia(new Date());
      const eventos = await listarEventos(auth, hoje, inicioDoDia(new Date(), 1));
      const contexto = [
        resumoDiario(eventos, hoje, 'Agenda de hoje', formatarTarefas()),
        'followups.json: ' + (fs.existsSync(new URL('../followups.json', import.meta.url).pathname)
          ? fs.readFileSync(new URL('../followups.json', import.meta.url).pathname, 'utf8')
          : '[]'),
      ].join('\n\n');
      const briefing = await gerarBriefing(contexto);
      if (briefing) await enviarMensagem(briefing);
    }));
    // verificação diária das 6h: saúde do app + uma melhoria por dia (MELHORIAS.md)
    agendar('verificacao', '0 6 * * *', null, () => comSaude(async () => {
      const msg = await verificacaoDiaria();
      if (msg) await enviarMensagem(msg);
    }));
    // diagnóstico diário das automações do Mac (só avisa se algo quebrou)
    agendar('diagnostico', '0 8 * * *', null, () => comSaude(async () => {
      const alerta = await diagnosticarAutomacoes();
      if (alerta) await enviarMensagem(alerta);
    }));
    // lembretes recorrentes insistentes: verifica no início de cada hora
    agendar('recorrentes', '0 * * * *', null, () => comSaude(async () => {
      const hora = horaAgora();
      for (const msg of lembretesParaAgora(hora)) await enviarMensagem(msg);
    }));

    console.log(`Agendado: diário (${CONFIG.cronDiario}), semanal (${CONFIG.cronSemanal}), noturno (${CONFIG.cronNoturno}), lembretes ${CONFIG.lembreteMinutos.join('/')}min antes — ${CONFIG.timezone}`);

    const chatsAutorizados = new Set([
      `${CONFIG.destinatario}@c.us`,
      ...(CONFIG.chatsExtras ?? []),
    ]);
    const PREFIXOS_BOT = ['✅', '🤖', '❓', '☀️', '🗓', '🌙', '🌅', '🔔', '🗑', '🔁', '🕓', '📚', '😅', '🤔', '👋', '📝', '🕐', '📋', '⚠️', '👍', '📌', '⏰', '🚨', '📊', '⏳', '🧠', '💡', '🩺'];
    whatsapp.on('message_create', async (msg) => {
      try {
        // id do chat derivado da própria mensagem (msg.getChat() está quebrado
        // em algumas versões do WhatsApp Web — evitamos depender dele)
        const chatId = msg.fromMe ? msg.to : msg.from;
        if (chatId === 'status@broadcast') return; // Status de contatos: ignora sem poluir o log
        const isGroup = chatId.endsWith('@g.us');
        const isAudio = audioDisponivel && (msg.type === 'ptt' || msg.type === 'audio');
        if (!isAudio && (!msg.body || msg.body.startsWith(MARCA_BOT) || PREFIXOS_BOT.some((p) => msg.body.startsWith(p)))) return;

        // conversa "com você mesmo" (formato antigo @c.us ou novo @lid),
        // ou mensagem SUA no grupo do bot
        const isConversaPropria =
          msg.from === msg.to ||
          chatsAutorizados.has(chatId) ||
          (grupoId && chatId === grupoId && msg.fromMe);

        // conversa direta com a secretária: só mensagens DELA (não as suas)
        let isSecretaria = false;
        if (!isConversaPropria && !msg.fromMe && !isGroup && CONFIG.secretaria) {
          isSecretaria =
            (CONFIG.secretariaChats ?? []).includes(chatId) ||
            msg.from === `${CONFIG.secretaria}@c.us`;
          if (!isSecretaria) {
            const contato = await msg.getContact().catch(() => null);
            isSecretaria = contato?.number === CONFIG.secretaria;
          }
        }

        if (!isConversaPropria && !isSecretaria) {
          console.log(`[msg ignorada] chat=${chatId} from=${msg.from} to=${msg.to}`);
          return;
        }

        const origem = isConversaPropria ? 'self' : `sec:${chatId}`;

        // mensagem de voz: transcreve localmente e trata como texto
        let texto = msg.body;
        let prefixoAudio = '';
        if (isAudio) {
          const media = await msg.downloadMedia();
          if (!media?.data) return;
          console.log(`[${new Date().toISOString()}] Áudio recebido (${origem}), transcrevendo...`);
          texto = await transcreverAudio(media.data);
          if (!texto) {
            await enviarPara(chatId, t('audio.fail'));
            return;
          }
          prefixoAudio = t('audio.heard', { text: texto }) + '\n\n';
        }

        console.log(`[${new Date().toISOString()}] Mensagem recebida (${origem}): ${texto.slice(0, 60)}`);

        // ponte Claude/relatório: responde na hora e roda em background
        const bridge = interceptarBridge(texto, origem);
        if (bridge) {
          await enviarPara(chatId, prefixoAudio + bridge.aviso);
          if (bridge.rodar) {
            bridge.rodar()
              .then((resp) => enviarPara(chatId, resp))
              .catch((err) => {
                console.error('claude-bridge:', err.message);
                return enviarPara(chatId, `🤖 Erro no pedido: ${err.message}`);
              });
          }
          return;
        }

        const resposta = await processarComando(texto, auth, origem);
        if (resposta) {
          await enviarPara(chatId, prefixoAudio + resposta);
          // avisa o dono quando a secretária conclui uma ação na agenda
          if (origem !== 'self' && resposta.startsWith('✅')) {
            await enviarMensagem(t('secretary.notice', { msg: resposta.split('\n')[0] }));
          }
        }
      } catch (err) {
        console.error('Erro ao processar comando:', err.message);
        try {
          await enviarPara(msg.fromMe ? msg.to : msg.from, t('err.exec', { err: err.message }));
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
  registrarQueda(`erro fatal: ${err.message}`);
  notificarMac('Agenda WhatsApp', `Serviço parou: ${err.message}`);
  process.exit(1);
});
