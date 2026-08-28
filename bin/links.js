#!/usr/bin/env node
// Fila de links do grupo "my.repo": o bot coleta, este comando lê. Rodar da
// RAIZ do projeto (my-repo.json é resolvido pelo cwd).
//
//   node bin/links.js                 lista os links ainda não analisados
//   node bin/links.js todos           lista tudo, com status
//   node bin/links.js analisado 2     marca o 2º da fila como analisado
//   node bin/links.js ignorado <url>  descarta um link sem analisar
//   node bin/links.js --json          saída crua, para consumo por script
import { listarLinks, marcarLink } from '../src/myrepo.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [modo, chave] = args.filter((a) => a !== '--json');

const linha = (l, i) =>
  `${String(i + 1).padStart(2)}. [${l.tipo}] ${l.url}` +
  (l.nota ? `\n    nota: ${l.nota}` : '') +
  `\n    ${l.recebidoEm.slice(0, 16).replace('T', ' ')}${l.status === 'novo' ? '' : ` — ${l.status}`}`;

if (modo === 'analisado' || modo === 'ignorado' || modo === 'novo') {
  if (!chave) {
    console.error(`Uso: node bin/links.js ${modo} <número|url|id>`);
    process.exit(1);
  }
  const alvo = marcarLink(chave, modo);
  if (!alvo) {
    console.error(`Link não encontrado: ${chave}`);
    process.exit(1);
  }
  console.log(`${alvo.url} → ${alvo.status}`);
} else {
  const status = modo === 'todos' ? 'todos' : 'novo';
  const lista = listarLinks(status);
  if (json) {
    console.log(JSON.stringify(lista, null, 2));
  } else if (lista.length === 0) {
    console.log(status === 'todos' ? 'Nenhum link capturado ainda.' : 'Nenhum link novo na fila.');
  } else {
    console.log(`${lista.length} link(s)${status === 'todos' ? '' : ' na fila'}:\n`);
    console.log(lista.map(linha).join('\n\n'));
  }
}
