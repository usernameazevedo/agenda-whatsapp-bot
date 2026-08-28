// Caixa de entrada de links: o grupo "my.repo" no WhatsApp é onde o dono joga
// repos, vídeos e sites que quer transformar em análise/referência no Claude.
// O bot só COLETA — a análise é sempre pedida a mão numa sessão, nunca
// disparada por aqui.
import fs from 'node:fs';
import path from 'node:path';

const ARQUIVO = path.resolve('my-repo.json');

// URL sem espaço nem caractere de fechamento; a pontuação grudada no fim é
// aparada depois (o WhatsApp entrega "veja https://x.com/y." com o ponto).
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const LIXO_FINAL = /[.,;:!?)\]}>'"]+$/;

function carregar() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
  } catch {
    return [];
  }
}

function salvar(lista) {
  fs.writeFileSync(ARQUIVO, JSON.stringify(lista, null, 2));
}

/** Classificação grosseira só para orientar quem for analisar depois. */
function tipoDe(url) {
  const u = url.toLowerCase();
  if (/(github\.com|gitlab\.com|bitbucket\.org|huggingface\.co)/.test(u)) return 'repo';
  if (/(youtube\.com|youtu\.be|tiktok\.com|instagram\.com\/(reel|p)|vimeo\.com|x\.com\/\w+\/status)/.test(u)) return 'video';
  return 'site';
}

/** URLs distintas de um texto, na ordem em que aparecem. */
export function extrairLinks(texto) {
  const achados = (texto ?? '').match(URL_RE) ?? [];
  const limpas = achados.map((u) => u.replace(LIXO_FINAL, '')).filter(Boolean);
  return [...new Set(limpas)];
}

/**
 * Guarda os links de uma mensagem. Devolve só os que entraram agora —
 * URL repetida é ignorada para o mesmo link não voltar à fila.
 */
export function capturarLinks(texto, meta = {}) {
  const urls = extrairLinks(texto);
  if (urls.length === 0) return [];

  const lista = carregar();
  const jaTem = new Set(lista.map((x) => x.url));
  // a mensagem sem as URLs é o comentário do dono ("isso aqui pro pipeline")
  const nota = (texto ?? '').replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();

  const novos = urls
    .filter((url) => !jaTem.has(url))
    .map((url) => ({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      url,
      tipo: tipoDe(url),
      nota,
      autor: meta.autor ?? null,
      recebidoEm: new Date().toISOString(),
      status: 'novo',
      analisadoEm: null,
    }));

  if (novos.length > 0) salvar([...lista, ...novos]);
  return novos;
}

/** Links guardados; sem filtro devolve só os que ainda não foram analisados. */
export function listarLinks(status = 'novo') {
  const lista = carregar();
  return status === 'todos' ? lista : lista.filter((x) => x.status === status);
}

/**
 * Muda o status de um link, localizado por id, por URL ou pela posição (1-based)
 * na lista de novos. Devolve o link atualizado, ou null se não achou.
 */
export function marcarLink(chave, status = 'analisado') {
  const lista = carregar();
  const porPosicao = /^\d+$/.test(String(chave)) ? listarLinks('novo')[Number(chave) - 1] : null;
  const alvo = lista.find((x) => x.id === chave || x.url === chave || x.id === porPosicao?.id);
  if (!alvo) return null;

  const atualizado = {
    ...alvo,
    status,
    analisadoEm: status === 'novo' ? null : new Date().toISOString(),
  };
  salvar(lista.map((x) => (x.id === alvo.id ? atualizado : x)));
  return atualizado;
}
