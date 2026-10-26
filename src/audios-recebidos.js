// Último áudio de cada contato, para transcrever sob pedido do dono.
//
// "transcreve o último áudio do Johann" → o bot acha o áudio mais recente de
// quem tem "Johann" no nome (ou no número) e devolve o texto.
//
// Por que guardar no momento em que chega: o bot recebe tudo, mas mensagem de
// terceiro é descartada pelo gate de autor do index.js — e o Baileys não tem
// "buscar mensagem antiga" depois. O que fica em disco é só a REFERÊNCIA do
// áudio (chave de mídia + caminho no servidor do WhatsApp), não o som: o
// download e a transcrição acontecem só quando o dono pede.
import fs from 'node:fs';
import { BufferJSON } from 'baileys';

const ARQUIVO = 'audios-recebidos.json'; // resolvido pelo cwd, como os demais dados de runtime
// Um registro por contato; ao passar do teto, sai quem mandou áudio há mais tempo.
const LIMITE_CONTATOS = 100;

// minúsculas e sem acento: "Áudio" e "audio" têm de casar igual
const normalizar = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function ler() {
  if (!fs.existsSync(ARQUIVO)) return {};
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'), BufferJSON.reviver);
  } catch (err) {
    // arquivo corrompido não pode derrubar o handler de mensagens
    console.error(`[audios] ${ARQUIVO} ilegível, recomeçando vazio:`, err.message);
    return {};
  }
}

function gravar(dados) {
  // BufferJSON preserva a chave de mídia (Uint8Array), sem a qual o download falha
  fs.writeFileSync(ARQUIVO, JSON.stringify(dados, BufferJSON.replacer, 2));
}

/**
 * Guarda o áudio como o mais recente do autor.
 * `mensagem` é a mensagem bruta do Baileys — é dela que o download depende.
 */
export function registrarAudio({ autorId, chatId, nome, hora, mensagem }) {
  const chave = autorId || chatId;
  if (!chave || !mensagem) return;
  const dados = ler();
  const anterior = dados[chave];
  // fila offline pode entregar fora de ordem: áudio mais velho não sobrescreve
  if (anterior && anterior.hora > hora) return;
  dados[chave] = {
    autorId: chave,
    chatId,
    // pushName às vezes não vem; mantém o último nome conhecido do contato
    nome: nome || anterior?.nome || null,
    hora: hora || Date.now(),
    mensagem,
  };
  const chaves = Object.keys(dados);
  if (chaves.length > LIMITE_CONTATOS) {
    chaves
      .sort((a, b) => dados[a].hora - dados[b].hora)
      .slice(0, chaves.length - LIMITE_CONTATOS)
      .forEach((k) => delete dados[k]);
  }
  gravar(dados);
}

/**
 * Áudio mais recente de quem casa com a consulta: pedaço do nome ("johann")
 * ou do número ("9988"). Entre vários que casam, vence o mais novo.
 */
export function buscarUltimoAudio(consulta) {
  const q = normalizar(consulta);
  if (!q) return null;
  const digitos = q.replace(/\D/g, '');
  // só trata como número quando a consulta é basicamente dígitos
  const porNumero = digitos.length >= 4 && digitos.length >= q.replace(/[\s+()-]/g, '').length;
  const candidatos = Object.values(ler()).filter((r) =>
    porNumero ? String(r.autorId).split('@')[0].includes(digitos) : normalizar(r.nome).includes(q),
  );
  if (candidatos.length === 0) return null;
  return candidatos.reduce((a, b) => (b.hora > a.hora ? b : a));
}

// "escutar e transcrever o último áudio do Johann", "transcreve o audio da Ana?",
// "transcribe the last voice note from John". O verbo de ouvir/transcrever e a
// palavra áudio precisam estar lá: "o Johann mandou áudio" não é pedido.
const PEDIDO_PT = /\b(?:transcrev|escut|ouv|ouc)\w*\b.*?\baudios?\b.*?\b(?:do|da|de)\s+(.+)$/;
const PEDIDO_EN = /\b(?:transcribe|listen)\w*\b.*?\b(?:audio|voice note|voice message)s?\b.*?\bfrom\s+(.+)$/;

/** Nome/número pedido, ou null se o texto não é um pedido de transcrição. */
export function pedidoDeTranscricao(texto) {
  const t = normalizar(texto);
  const achado = t.match(PEDIDO_PT) ?? t.match(PEDIDO_EN);
  if (!achado) return null;
  const quem = achado[1].replace(/[?.!,;:]+$/, '').trim();
  return quem || null;
}
