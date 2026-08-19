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

// Quantos ids de mensagem guardamos para reconhecer envios próprios e evitar
// processar a mesma mensagem duas vezes. Não precisa ser grande: só cobre a
// janela entre uma reconexão e a seguinte.
const LIMITE_IDS = 500;

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

// Set com teto: ao encher, descarta o mais antigo (Set preserva a ordem de
// inserção, então o primeiro valor é sempre o mais velho).
function lembrar(conjunto, id) {
  if (!id) return;
  conjunto.add(id);
  if (conjunto.size > LIMITE_IDS) conjunto.delete(conjunto.values().next().value);
}

// `messageTimestamp` chega em segundos e, dependendo do caminho no Baileys,
// como número, string ou Long do protobuf. Sem hora legível devolvemos 0, que
// faz a mensagem ser tratada como antiga — é o lado seguro do erro.
function horaEmMs(mensagem) {
  const t = mensagem?.messageTimestamp;
  const segundos = Number(typeof t === 'object' && t !== null ? (t.low ?? t.toString()) : t);
  return Number.isFinite(segundos) && segundos > 0 ? segundos * 1000 : 0;
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
    // Cada socket criado ganha um número. Eventos de sockets antigos (que ainda
    // estão fechando) são descartados: sem isso, o "close" de um socket morto
    // dispara mais uma reconexão, e as conexões se multiplicam até o WhatsApp
    // derrubar todas com "Stream Errored (conflict)".
    this.geracao = 0;
    // De quando em diante uma mensagem entregue pela fila offline conta como
    // nova. Fixado UMA vez no boot: o index.js sobrescreve com o começo da
    // parada registrada, antes de conectar. As reconexões internas não mexem
    // nele de propósito — ele é um piso no passado, e qualquer mensagem de uma
    // reconexão posterior é mais nova que esse piso.
    this.marcoOffline = Date.now();
    // Ids do que nós mesmos enviamos: o Baileys reemite cada envio como
    // 'append' (emitOwnEvents), e no chat consigo mesmo a resposta do bot é
    // indistinguível de um comando do dono — os dois são fromMe. O index.js já
    // barra o próprio texto pelo prefixo MARCA_BOT; isto é a mesma defesa na
    // camada de transporte, para ela não depender de um marcador de fora.
    this.idsEnviados = new Set();
    // Ids já entregues ao index.js: a mesma mensagem pode aparecer como
    // 'notify' e voltar como 'append', e comando repetido cria tarefa dupla.
    this.idsProcessados = new Set();
  }

  /** Define de quando em diante a fila offline conta como mensagem nova. */
  definirMarcoOffline(ms) {
    if (Number.isFinite(ms) && ms > 0) this.marcoOffline = ms;
  }

  // Encerra o socket atual e solta seus listeners antes de criar outro.
  encerrarSocket() {
    if (!this.sock) return;
    try {
      this.sock.ev.removeAllListeners('creds.update');
      this.sock.ev.removeAllListeners('connection.update');
      this.sock.ev.removeAllListeners('messages.upsert');
      this.sock.end(undefined);
    } catch { /* socket já estava morto */ }
    this.sock = null;
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
    this.encerrarSocket();
    const geracao = ++this.geracao;

    const { state, saveCreds } = await useMultiFileAuthState(PASTA_AUTH);
    this.salvarCredenciais = saveCreds;
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: loggerSilencioso,
      // Identificação que aparece em "Aparelhos conectados" no celular.
      browser: Browsers.macOS('Agenda Bot'),
      // O bot não precisa marcar mensagens como lidas por conta própria.
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => this.aoAtualizarConexao(u, geracao));
    sock.ev.on('messages.upsert', (u) => {
      if (geracao === this.geracao) this.aoReceberMensagens(u);
    });
  }

  aoAtualizarConexao({ connection, lastDisconnect, qr }, geracao) {
    // Evento de socket antigo: ignorar, senão vira reconexão em cascata.
    if (geracao !== undefined && geracao !== this.geracao) return;

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
    // 'notify' = mensagem ao vivo.
    //
    // 'append' junta três coisas diferentes (baileys/lib/Socket/messages-recv.js
    // usa `node.attrs.offline ? 'append' : 'notify'`):
    //   a) sincronização de histórico — reprocessar reexecuta comando velho;
    //   b) o que nós mesmos enviamos (messages-send.js, emitOwnEvents);
    //   c) a FILA OFFLINE: o que chegou enquanto o bot estava fora.
    //
    // Descartar 'append' inteiro era simples, mas jogava fora (c) junto: todo
    // comando enviado durante uma queda sumia em silêncio. Agora separamos os
    // três — id próprio elimina (b), o marco da queda elimina (a).
    if (type !== 'notify' && type !== 'append') return;

    for (const m of messages ?? []) {
      if (!m.message) continue; // notificação de protocolo, sem conteúdo
      const id = m.key?.id;

      if (type === 'append') {
        if (id && this.idsEnviados.has(id)) continue;      // (b) resposta nossa
        if (horaEmMs(m) < this.marcoOffline) continue;     // (a) histórico velho
      }
      if (id && this.idsProcessados.has(id)) continue;
      lembrar(this.idsProcessados, id);

      const conteudo = desembrulhar(m.message);
      const audio = conteudo?.audioMessage ?? null;

      this.emitir('message', {
        chatId: m.key.remoteJid,
        fromMe: Boolean(m.key.fromMe),
        // Em grupo, participant identifica quem falou; fora dele é o próprio
        // chat. Atenção ao `||`: em conversas diretas por @lid o Baileys manda
        // participant como string VAZIA, e com `??` o autor ficaria em branco —
        // o que fazia toda mensagem da secretária ser descartada como se fosse
        // de um desconhecido.
        autorId: m.key.participant || m.key.remoteJid,
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
    const enviada = await this.sock.sendMessage(normalizarId(chatId), { text: texto });
    // O Baileys devolve o que enviamos pelo mesmo evento de entrada, marcado
    // como 'append'. Guardar o id é o que impede o bot de tratar a própria
    // resposta como um comando novo no chat consigo mesmo.
    lembrar(this.idsEnviados, enviada?.key?.id);
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
    this.encerrarSocket();
    this.conectado = false;
  }
}
