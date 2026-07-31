// Camada de WhatsApp sobre o Baileys (WebSocket, sem navegador).
//
// Expõe a mesma superfície que o index.js já usava com o whatsapp-web.js
// (on/sendMessage/listarGrupos/getState/initialize/destroy), para que a troca
// de biblioteca ficasse contida aqui.
//
// Diferenças do protocolo que esta camada esconde:
//  - IDs: o Baileys usa `@s.whatsapp.net`, não `@c.us`. Tudo que entra é
//    normalizado e tudo que sai aceita os dois formatos.
//  - Não há evento "ready" separado: a conexão abre em `connection.update`.
//  - Reconexão é responsabilidade nossa; o Baileys só avisa que caiu.
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState,
  Browsers,
} from 'baileys';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASTA_AUTH = path.join(RAIZ, '.baileys_auth');

// Reconexão: tentativas rápidas antes de desistir e deixar o watchdog agir.
const MAX_RECONEXOES = 5;
const ESPERA_RECONEXAO_MS = 5000;

// O Baileys espera um logger no formato do pino; não queremos o ruído dele no
// log do bot, então entregamos um que descarta tudo.
const loggerSilencioso = {
  level: 'silent',
  fatal() {}, error() {}, warn() {}, info() {}, debug() {}, trace() {},
  child() { return loggerSilencioso; },
};

/** Converte `@c.us` (formato do whatsapp-web.js) para o formato do Baileys. */
export function normalizarId(id) {
  if (!id) return id;
  const texto = String(id);
  if (texto.endsWith('@c.us')) return texto.replace(/@c\.us$/, '@s.whatsapp.net');
  if (!texto.includes('@')) return `${texto}@s.whatsapp.net`;
  return texto;
}

/** Só os dígitos do identificador, para comparar chats sem depender do domínio. */
export function numeroDe(id) {
  return String(id ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

export const ehGrupo = (id) => String(id ?? '').endsWith('@g.us');

// Extrai o texto de qualquer um dos formatos de mensagem que nos interessam.
function textoDaMensagem(mensagem) {
  if (!mensagem) return '';
  return (
    mensagem.conversation ??
    mensagem.extendedTextMessage?.text ??
    mensagem.imageMessage?.caption ??
    mensagem.videoMessage?.caption ??
    mensagem.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    ''
  );
}

// Mensagens efêmeras e "view once" vêm embrulhadas em outra camada.
function desembrulhar(mensagem) {
  return (
    mensagem?.ephemeralMessage?.message ??
    mensagem?.viewOnceMessage?.message ??
    mensagem?.viewOnceMessageV2?.message ??
    mensagem?.documentWithCaptionMessage?.message ??
    mensagem
  );
}

export class WhatsApp {
  constructor() {
    this.sock = null;
    this.ouvintes = new Map();
    this.conectado = false;
    this.encerrando = false;
    this.reconexoes = 0;
    this.meuJid = null;
    this.salvarCredenciais = null;
  }

  on(evento, callback) {
    if (!this.ouvintes.has(evento)) this.ouvintes.set(evento, []);
    this.ouvintes.get(evento).push(callback);
  }

  emitir(evento, ...args) {
    for (const cb of this.ouvintes.get(evento) ?? []) {
      Promise.resolve()
        .then(() => cb(...args))
        .catch((err) => console.error(`Erro no handler de "${evento}":`, err.message));
    }
  }

  async initialize() {
    const { state, saveCreds } = await useMultiFileAuthState(PASTA_AUTH);
    this.salvarCredenciais = saveCreds;
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: loggerSilencioso,
      // Identificação que aparece em "Aparelhos conectados" no celular.
      browser: Browsers.macOS('Agenda Bot'),
      // O bot não precisa marcar mensagens como lidas por conta própria.
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('connection.update', (u) => this.aoAtualizarConexao(u));
    this.sock.ev.on('messages.upsert', (u) => this.aoReceberMensagens(u));
  }

  aoAtualizarConexao({ connection, lastDisconnect, qr }) {
    if (qr) this.emitir('qr', qr);

    if (connection === 'open') {
      this.conectado = true;
      this.reconexoes = 0;
      this.meuJid = jidNormalizedUser(this.sock.user?.id);
      this.emitir('ready');
      return;
    }

    if (connection !== 'close') return;

    this.conectado = false;
    if (this.encerrando) return;

    const codigo = lastDisconnect?.error?.output?.statusCode;
    const motivo = lastDisconnect?.error?.message ?? `código ${codigo}`;

    // Sessão invalidada: reconectar não adianta, é preciso escanear de novo.
    if (codigo === DisconnectReason.loggedOut) {
      this.emitir('auth_failure', 'sessão encerrada no celular (Aparelhos conectados)');
      return;
    }

    // Queda comum (rede, restart pedido pelo servidor): o Baileys não reconecta
    // sozinho, então recriamos o socket algumas vezes antes de entregar o
    // problema ao watchdog, que reinicia o processo limpo.
    if (this.reconexoes < MAX_RECONEXOES) {
      this.reconexoes += 1;
      console.warn(`[whatsapp] conexão caiu (${motivo}); reconectando ${this.reconexoes}/${MAX_RECONEXOES}...`);
      setTimeout(() => {
        this.initialize().catch((err) => {
          console.error('[whatsapp] falha ao reconectar:', err.message);
          this.emitir('disconnected', err.message);
        });
      }, ESPERA_RECONEXAO_MS);
      return;
    }

    this.emitir('disconnected', motivo);
  }

  aoReceberMensagens({ messages, type }) {
    // 'notify' = mensagem chegando agora. 'append' é sincronização de histórico,
    // que reprocessaria comandos antigos a cada reconexão.
    if (type !== 'notify') return;

    for (const m of messages ?? []) {
      if (!m.message) continue; // notificação de protocolo, sem conteúdo
      const conteudo = desembrulhar(m.message);
      const audio = conteudo?.audioMessage ?? null;

      this.emitir('message', {
        chatId: m.key.remoteJid,
        fromMe: Boolean(m.key.fromMe),
        // Em grupo, participant identifica quem falou; fora dele é o próprio chat.
        autorId: m.key.participant ?? m.key.remoteJid,
        body: textoDaMensagem(conteudo),
        isAudio: Boolean(audio),
        nome: m.pushName ?? null,
        baixarAudio: audio
          ? async () => {
              const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: loggerSilencioso });
              return buffer.toString('base64');
            }
          : null,
      });
    }
  }

  async sendMessage(chatId, texto) {
    if (!this.sock) throw new Error('WhatsApp ainda não inicializado');
    await this.sock.sendMessage(normalizarId(chatId), { text: texto });
  }

  /** Lista os grupos de que o número participa: [{ id, name }]. */
  async listarGrupos() {
    if (!this.sock) return [];
    const grupos = await this.sock.groupFetchAllParticipating();
    return Object.values(grupos).map((g) => ({ id: g.id, name: g.subject ?? '' }));
  }

  /** Compatível com o getState() do whatsapp-web.js, usado pelo watchdog. */
  async getState() {
    return this.conectado ? 'CONNECTED' : null;
  }

  /** JID do próprio dono (definido depois de conectar). */
  get jidProprio() {
    return this.meuJid;
  }

  async destroy() {
    this.encerrando = true;
    try {
      this.sock?.end(undefined);
    } catch { /* socket já fechado */ }
    this.conectado = false;
  }
}
