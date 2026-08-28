import cron from 'node-cron';
import qrcode from 'qrcode-terminal';
import { WhatsApp, normalizarId, numeroDe, ehGrupo } from './whatsapp.js';
import { CONFIG } from './config.js';
import { getAuthClient, listarEventos } from './calendar.js';
import { resumoDiario, resumoSemanal } from './formatar.js';
import { processarComando } from './comandos.js';
import { lembretesParaAgora } from './recorrentes.js';
import { verificarLembretes } from './lembretes.js';
import { postergarPendentes, formatarTarefas, fechamentoDoDia, criarTarefa, renumerarVisiveis, tarefasVisiveis, hojeStr } from './tarefas.js';
import { paraCobrar, atualizarFollowup } from './followups.js';
import { transcreverAudio, audioDisponivel } from './audio.js';
import { interceptarBridge, gerarBriefing } from './claude-bridge.js';
import { diagnosticarAutomacoes } from './diagnostico.js';
import { verificacaoDiaria } from './verificacao.js';
import { notificar, registrarErroGoogle, registrarSucessoGoogle } from './saude.js';
import { horarioDoCron, agoraLocal, ficouParaTras, lerExecucoes, umaVezPorDia } from './jobs.js';
import { capturarLinks } from './myrepo.js';
import { t } from './i18n.js';

const whatsapp = new WhatsApp();

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
  notificar('Agenda WhatsApp', t('notif.qr'));
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

// Modo de validação: recebe e processa tudo, mas não envia nada. Serve para
// rodar a versão nova em paralelo com a antiga sem duplicar respostas.
const DRY_RUN = process.argv.includes('--dry-run');

async function enviarPara(chatId, texto) {
  if (DRY_RUN) {
    console.log(`[dry-run] enviaria para ${chatId}: ${texto.slice(0, 120).replace(/\n/g, ' | ')}`);
    return;
  }
  await whatsapp.sendMessage(chatId, MARCA_BOT + texto);
  console.log(`[${new Date().toISOString()}] Bot respondeu: ${texto.slice(0, 100).replace(/\n/g, ' | ')}`);
}

// id do grupo de destino (resolvido no ready); null = conversa consigo mesmo
let grupoId = null;
// id do grupo caixa-de-entrada de links (my.repo); null = recurso desligado
let grupoLinksId = null;

// compara nomes de grupo ignorando espaços, emoji, acentos e maiúsculas
const nomeNormalizado = (s) =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();

// Lista de grupos vem direto do protocolo. O workaround de ler o Store da
// página (necessário quando o getChats() do whatsapp-web.js quebrou em jul/2026)
// deixou de existir junto com o navegador.
const listarGrupos = () => whatsapp.listarGrupos();

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

// Caixa de entrada de links. Resolvido junto do grupo principal, mas com falha
// silenciosa: sem esse grupo o bot segue normal, só não coleta link nenhum.
async function resolverGrupoLinks() {
  if (!CONFIG.grupoLinks && !CONFIG.grupoLinksId) return;
  try {
    if (CONFIG.grupoLinks) {
      const alvo = nomeNormalizado(CONFIG.grupoLinks);
      const g = (await listarGrupos()).find(
        (c) => c.name === CONFIG.grupoLinks || nomeNormalizado(c.name) === alvo,
      );
      if (g) {
        grupoLinksId = g.id;
        console.log(`Links do grupo "${CONFIG.grupoLinks}" (${grupoLinksId}) serão guardados em my-repo.json.`);
        return;
      }
    }
  } catch (err) {
    console.error('Falha ao resolver grupo de links por nome:', err.message);
  }
  if (CONFIG.grupoLinksId) {
    grupoLinksId = CONFIG.grupoLinksId;
    console.log(`Links do grupo (ID fixo ${grupoLinksId}) serão guardados em my-repo.json.`);
  } else {
    console.warn(`Grupo de links "${CONFIG.grupoLinks}" não encontrado — coleta desligada.`);
  }
}

async function enviarMensagem(texto) {
  await enviarPara(grupoId ?? `${CONFIG.destinatario}@s.whatsapp.net`, texto);
}

// cópia para a conversa direta com a secretária (falha não derruba o job)
async function enviarSecretaria(texto) {
  if (!CONFIG.secretaria) return;
  try {
    await enviarPara(`${CONFIG.secretaria}@s.whatsapp.net`, texto);
  } catch (err) {
    console.error('Falha ao enviar cópia à secretária:', err.message);
  }
}

async function comSaude(fn) {
  try {
    await fn();
    registrarSucessoGoogle();
  } catch (err) {
    registrarErroGoogle(err);
  }
}

// Jobs de horário fixo já registrados, para recuperar o que a máquina dormiu
// por cima. Preenchido uma vez, no primeiro "ready".
const jobsRecuperaveis = [];

// Roda o que ficou para trás. Chamado a cada reconexão porque, na prática,
// toda soneca da máquina derruba o socket do WhatsApp: reconectar é o sinal
// disponível de que a máquina acordou.
async function recuperarJobsAtrasados() {
  const agora = agoraLocal(CONFIG.timezone);
  const marcas = lerExecucoes();
  for (const job of jobsRecuperaveis) {
    if (!ficouParaTras(job.expr, marcas[job.nome], agora)) continue;
    console.log(`[cron] "${job.nome}" (${job.expr}) ficou para trás — executando atrasado.`);
    await comSaude(() => umaVezPorDia(job.nome, hojeStr(), job.fn));
  }
}

async function executarDiario(auth) {
  const hoje = inicioDoDia(new Date());
  // postergação automática: pendentes de ontem ganham ❌ no histórico e cópia hoje
  const movidas = postergarPendentes();
  // tarefas mensais fixas do config entram na lista no dia marcado
  const diaDoMes = Number(hojeStr().slice(-2));
  for (const m of CONFIG.tarefasMensais ?? []) {
    if (m.dia !== diaDoMes) continue;
    const jaExiste = tarefasVisiveis().some((x) => !x.feito && x.texto === m.texto);
    if (!jaExiste) criarTarefa(m.texto);
  }
  // cobranças de orçamento vencidas viram linha na lista do dia (sem interrogatório)
  for (const f of paraCobrar()) {
    criarTarefa(t('followup.chase.title', { client: f.cliente }));
    atualizarFollowup(f.id, { status: 'na_lista' });
  }
  // única renumeração do dia: a lista das 7h define os números até amanhã
  renumerarVisiveis();
  const eventos = await listarEventos(auth, hoje, inicioDoDia(new Date(), 1));
  let msg = resumoDiario(eventos, hoje, t('daily.title.morning'), formatarTarefas());
  if (movidas > 0) msg += `\n${t('task.postponed.auto', { n: movidas })}`;
  await enviarMensagem(msg);
  await enviarSecretaria(msg); // secretária recebe o resumo do dia automaticamente
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

// `silencioso` marca parada pedida por nós (pm2, deploy): o marco continua
// valendo para reprocessar a fila offline, mas não vira alarme no WhatsApp.
// Uma queda de verdade nunca é silenciada por um reinício posterior.
function registrarQueda(motivo, { silencioso = false } = {}) {
  try {
    let reg = null;
    try { reg = JSON.parse(fs.readFileSync(DOWNTIME, 'utf8')); } catch { /* primeira queda */ }
    const agora = new Date().toISOString();
    reg = reg?.inicio
      ? { ...reg, motivo, reinicios: (reg.reinicios ?? 0) + 1, silencioso: Boolean(reg.silencioso) && silencioso }
      : { inicio: agora, motivo, reinicios: 1, silencioso };
    fs.writeFileSync(DOWNTIME, JSON.stringify(reg, null, 1));
  } catch (err) {
    console.error('Falha ao registrar queda:', err.message);
  }
}

// Ao reconectar, o WhatsApp entrega o que chegou durante a queda. Essas
// mensagens vêm marcadas como 'append', igual ao histórico antigo, e só o
// horário separa uma coisa da outra — daí o início da queda virar o corte.
// Lido antes de conectar porque avisarRecuperacao() apaga o arquivo.
function marcoDaUltimaQueda() {
  try {
    const reg = JSON.parse(fs.readFileSync(DOWNTIME, 'utf8'));
    const ms = new Date(reg?.inicio).getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null; // sem queda registrada: o padrão do socket já serve
  }
}

async function avisarRecuperacao() {
  let reg;
  try { reg = JSON.parse(fs.readFileSync(DOWNTIME, 'utf8')); } catch { return; }
  try { fs.unlinkSync(DOWNTIME); } catch {}
  if (!reg?.inicio) return;
  // Parada que nós mesmos pedimos: o marco já foi aproveitado antes de conectar
  // para recuperar a fila offline, e avisar "ficou fora do ar" a cada deploy
  // seria só ruído.
  if (reg.silencioso) return;
  const fmt = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: CONFIG.timezone, hour12: false });
  const minutos = Math.max(1, Math.round((Date.now() - new Date(reg.inicio).getTime()) / 60000));
  const texto =
    `⚠️ *Bot ficou fora do ar* por ~${minutos} min\n` +
    `De ${fmt(reg.inicio)} até ${fmt(new Date().toISOString())}\n` +
    `Motivo: ${reg.motivo}${reg.reinicios > 1 ? ` (${reg.reinicios} reinícios até recuperar)` : ''}\n\n` +
    `O que o WhatsApp guardou na fila foi processado agora. Se algum pedido desse intervalo ficou sem resposta, reenvie.`;
  try {
    await enviarMensagem(texto);
  } catch (err) {
    console.error('Falha ao enviar aviso de recuperação:', err.message);
  }
}

async function reiniciarLimpo(motivo) {
  console.error(`[watchdog] ${motivo} — reiniciando para recuperar.`);
  registrarQueda(motivo);
  notificar('Agenda WhatsApp', t('notif.recover', { r: motivo }));
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
        chatId = `${item.para}@s.whatsapp.net`;
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

  // Diferente do whatsapp-web.js (onde uma queda matava o processo), aqui a
  // camada de WhatsApp reconecta sozinha e "ready" dispara de novo a cada
  // reconexão. Agendamentos e handler de mensagens são registrados UMA vez:
  // sem isto, cada reconexão duplicaria os crons e as respostas.
  let jaConfigurado = false;

  whatsapp.on('ready', async () => {
    conectado = true;
    aguardandoQr = false;
    falhasSeguidas = 0;
    console.log('WhatsApp conectado.');
    await resolverGrupo();
    await resolverGrupoLinks();
    await avisarRecuperacao();

    if (jaConfigurado) {
      // Reconexão. Como toda soneca da máquina derruba o socket, voltar a
      // conectar é o momento de consertar um horário perdido durante o sono.
      await recuperarJobsAtrasados();
      return;
    }
    jaConfigurado = true;

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
      // Horário fixo ("M H * * D") roda no máximo uma vez por dia e deixa
      // marca em disco — é a marca que permite recuperá-lo se a máquina dormiu
      // por cima do horário.
      // Job de frequência (lembretes, recorrentes) fica de fora de propósito:
      // recuperar uma noite dormida despejaria centenas de execuções.
      if (horarioDoCron(expr)) {
        jobsRecuperaveis.push({ nome, expr, fn });
        cron.schedule(expr, () => comSaude(() => umaVezPorDia(nome, hojeStr(), fn)), opts);
        return;
      }
      cron.schedule(expr, () => comSaude(fn), opts);
    };
    // `agendar` já envolve tudo em comSaude — e, nos horários fixos, na marca
    // de uma vez por dia. Por isso os jobs abaixo passam a função crua.
    agendar('diario', CONFIG.cronDiario, '0 7 * * *', () => executarDiario(auth));
    agendar('semanal', CONFIG.cronSemanal, '0 7 * * 1', () => executarSemanal(auth));
    agendar('noturno', CONFIG.cronNoturno, '0 21 * * *', () => executarNoturno(auth));
    agendar('lembretes', '* * * * *', null, () => verificarLembretes(auth, enviarMensagem));
    // briefing matinal inteligente (Claude analisa agenda + tarefas + followups)
    agendar('briefing', '10 7 * * 1-6', null, async () => {
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
    });
    // verificação diária das 6h: saúde do app + uma melhoria por dia (MELHORIAS.md)
    agendar('verificacao', '0 6 * * *', null, async () => {
      const msg = await verificacaoDiaria();
      if (msg) await enviarMensagem(msg);
    });
    // diagnóstico diário das automações do Mac (só avisa se algo quebrou)
    agendar('diagnostico', '0 8 * * *', null, async () => {
      const alerta = await diagnosticarAutomacoes();
      if (alerta) await enviarMensagem(alerta);
    });
    // lembretes recorrentes insistentes: verifica no início de cada hora
    agendar('recorrentes', '0 * * * *', null, async () => {
      const hora = horaAgora();
      for (const msg of lembretesParaAgora(hora)) await enviarMensagem(msg);
    });

    console.log(`Agendado: diário (${CONFIG.cronDiario}), semanal (${CONFIG.cronSemanal}), noturno (${CONFIG.cronNoturno}), lembretes ${CONFIG.lembreteMinutos.join('/')}min antes — ${CONFIG.timezone}`);
    console.log(`Recuperáveis se a máquina dormir por cima do horário: ${jobsRecuperaveis.map((j) => j.nome).join(', ')}`);
    await recuperarJobsAtrasados();

    // Números autorizados a comandar o bot, comparados só pelos dígitos: o
    // WhatsApp usa @s.whatsapp.net, @lid e @c.us para o mesmo contato.
    const numerosAutorizados = new Set(
      [CONFIG.destinatario, ...(CONFIG.chatsExtras ?? [])].map(numeroDe).filter(Boolean),
    );
    const numerosSecretaria = new Set(
      [CONFIG.secretaria, ...(CONFIG.secretariaChats ?? [])].map(numeroDe).filter(Boolean),
    );
    const PREFIXOS_BOT = ['✅', '🤖', '❓', '☀️', '🗓', '🌙', '🌅', '🔔', '🗑', '🔁', '🕓', '📚', '😅', '🤔', '👋', '📝', '🕐', '📋', '⚠️', '👍', '📌', '⏰', '🚨', '📊', '⏳', '🧠', '💡', '🩺'];
    whatsapp.on('message', async (msg) => {
      try {
        const chatId = msg.chatId;
        if (!chatId || chatId === 'status@broadcast') return; // Status de contatos

        // Caixa de entrada de links: o grupo é só depósito. Guarda o que tem
        // link, reage confirmando e sai — nada ali vira comando do bot, e a
        // análise só acontece quando for pedida numa sessão do Claude.
        if (grupoLinksId && chatId === grupoLinksId) {
          const novos = capturarLinks(msg.body, { autor: msg.nome });
          if (novos.length > 0) {
            console.log(`[my.repo] ${novos.length} link(s) guardado(s): ${novos.map((l) => l.url).join(', ')}`);
            if (!DRY_RUN) await whatsapp.reagir(msg.chave, '📥').catch(() => {});
          }
          return;
        }

        const isGroup = ehGrupo(chatId);
        const isAudio = audioDisponivel && msg.isAudio;
        if (!isAudio && (!msg.body || msg.body.startsWith(MARCA_BOT) || PREFIXOS_BOT.some((p) => msg.body.startsWith(p)))) return;

        // Conversa consigo mesmo (o chat é o próprio número, em qualquer um dos
        // formatos de ID), ou mensagem SUA no grupo do bot.
        // Cuidado: "fromMe" sozinho não serve — toda mensagem que o dono manda
        // para terceiros também é fromMe, e viraria comando para o bot.
        const numeroChat = numeroDe(chatId);
        const meuNumero = numeroDe(whatsapp.jidProprio);
        const isConversaPropria =
          (Boolean(numeroChat) && numeroChat === meuNumero) ||
          numerosAutorizados.has(numeroChat) ||
          (grupoId && chatId === grupoId && msg.fromMe);

        // Conversa direta com a secretária: só mensagens DELA, não as suas.
        const isSecretaria =
          !isConversaPropria &&
          !msg.fromMe &&
          !isGroup &&
          numerosSecretaria.has(numeroDe(msg.autorId || chatId));

        if (!isConversaPropria && !isSecretaria) {
          console.log(`[msg ignorada] chat=${chatId} autor=${msg.autorId} fromMe=${msg.fromMe}`);
          return;
        }

        const origem = isConversaPropria ? 'self' : `sec:${chatId}`;

        // mensagem de voz: transcreve localmente e trata como texto
        let texto = msg.body;
        let prefixoAudio = '';
        if (isAudio) {
          const dadosAudio = await msg.baixarAudio().catch((err) => {
            console.error('Falha ao baixar áudio:', err.message);
            return null;
          });
          if (!dadosAudio) return;
          console.log(`[${new Date().toISOString()}] Áudio recebido (${origem}), transcrevendo...`);
          texto = await transcreverAudio(dadosAudio);
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
          await enviarPara(msg.chatId, t('err.exec', { err: err.message }));
        } catch {}
      }
    });
    console.log('Comandos via WhatsApp ativos (envie "ajuda" na conversa com você mesmo).');
  });

  whatsapp.on('auth_failure', (msg) => {
    console.error('Falha de autenticação no WhatsApp:', msg);
    notificar('Agenda WhatsApp', t('notif.authfail'));
  });
  // camada 3: desconexão explícita → reinício limpo imediato
  whatsapp.on('disconnected', (reason) => {
    console.error('WhatsApp desconectado:', reason);
    conectado = false;
    reiniciarLimpo(`WhatsApp desconectou (${reason})`);
  });

  // Antes de abrir o socket: se houve queda, a fila offline vale a partir dela.
  const marco = marcoDaUltimaQueda();
  if (marco) whatsapp.definirMarcoOffline(marco);

  await whatsapp.initialize();
}

// desligamento gracioso: fecha o socket antes de sair
for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, async () => {
    console.log(`Recebido ${sinal}, encerrando...`);
    // Registra a parada ANTES de sair: é esse marco que, no próximo boot, faz
    // a fila offline do WhatsApp ser reprocessada a partir daqui. Sem ele, todo
    // `pm2 restart` (que manda SIGINT) engole em silêncio o que chegou durante
    // o reinício — que é o caminho de reinício mais comum deste bot.
    registrarQueda(`reinício solicitado (${sinal})`, { silencioso: true });
    try {
      await whatsapp.destroy();
    } catch {}
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Erro fatal:', err.message);
  registrarQueda(`erro fatal: ${err.message}`);
  notificar('Agenda WhatsApp', `Serviço parou: ${err.message}`);
  process.exit(1);
});
