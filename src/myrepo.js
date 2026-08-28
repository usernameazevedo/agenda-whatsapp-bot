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

// Arquivo ausente é fila vazia; arquivo ILEGÍVEL é erro que precisa estourar.
// Tratar os dois como [] faria a gravação seguinte sobrescrever a fila inteira
// com o link que acabou de chegar — perda silenciosa de tudo que estava lá.
function carregar() {
  let bruto;
  try {
    bruto = fs.readFileSync(ARQUIVO, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  try {
    const lista = JSON.parse(bruto);
    if (!Array.isArray(lista)) throw new Error('conteúdo não é uma lista');
    return lista;
  } catch (err) {
    throw new Error(`${ARQUIVO} ilegível (${err.message}) — conserte ou renomeie o arquivo antes de continuar`);
  }
}

// Escrita atômica: grava num temporário e renomeia. O rename é atômico no
// mesmo sistema de arquivos, então nem um crash no meio da escrita nem o CLI
// rodando junto com o bot deixam para trás um JSON pela metade.
function salvar(lista) {
  const tmp = `${ARQUIVO}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lista, null, 2));
  fs.renameSync(tmp, ARQUIVO);
}

/** Classificação grosseira só para orientar quem for analisar depois. */
function tipoDe(url) {
  const u = url.toLowerCase();
  if (/(github\.com|gitlab\.com|bitbucket\.org|huggingface\.co)/.test(u)) return 'repo';
  // post do X não é vídeo por padrão; o resto da lista é sempre player
  if (/(youtube\.com|youtu\.be|tiktok\.com|instagram\.com\/(reel|p)|vimeo\.com)/.test(u)) return 'video';
  return 'site';
}

// Parâmetros que as próprias redes grudam ao compartilhar. Sem tirá-los, o
// mesmo link colado do WhatsApp e do navegador vira duas entradas na fila.
// `t` (momento do vídeo) fica: é conteúdo, não rastreio.
const PARAM_RASTREIO = /^(utm_.*|fbclid|gclid|igshid|mibextid|si|ref_src|ref_url|s|share_id)$/i;

/**
 * Forma canônica usada só para COMPARAR links. A URL original é sempre a
 * guardada — é ela que vai ser aberta depois, com os parâmetros que vieram.
 */
export function chaveDe(url) {
  try {
    const u = new URL(url);
    u.protocol = 'https:';
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./i, '').toLowerCase();
    for (const p of [...u.searchParams.keys()]) {
      if (PARAM_RASTREIO.test(p)) u.searchParams.delete(p);
    }
    u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return url; // não é URL parseável: compara como texto mesmo
  }
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
  const jaTem = new Set(lista.map((x) => chaveDe(x.url)));
  // a mensagem sem as URLs é o comentário do dono ("isso aqui pro pipeline")
  const nota = (texto ?? '').replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();

  const novos = urls
    .filter((url) => {
      const chave = chaveDe(url);
      if (jaTem.has(chave)) return false;
      jaTem.add(chave); // duas variantes do mesmo link na MESMA mensagem
      return true;
    })
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
  const alvo = lista.find(
    (x) => x.id === chave || x.url === chave || chaveDe(x.url) === chaveDe(chave) || x.id === porPosicao?.id,
  );
  if (!alvo) return null;

  const atualizado = {
    ...alvo,
    status,
    analisadoEm: status === 'novo' ? null : new Date().toISOString(),
  };
  salvar(lista.map((x) => (x.id === alvo.id ? atualizado : x)));
  return atualizado;
}
