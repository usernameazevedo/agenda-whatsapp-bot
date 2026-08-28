// Regressão da caixa de entrada de links (src/myrepo.js).
//
// Rodar:  node test/myrepo.mjs
//
// Por que este teste existe: a fila do grupo "my.repo" é lida a mão depois, às
// vezes dias depois. Um link perdido ou duplicado só aparece quando já não dá
// para recuperar a mensagem original, então o que importa aqui é:
//   1. link colado com pontuação grudada  -> URL limpa
//   2. vários links na mesma mensagem     -> todos guardados
//   3. mesma URL de novo                  -> NÃO duplica a fila
//   4. comentário junto do link           -> vira a nota
//   5. mensagem sem link                  -> não cria entrada vazia
//   6. marcar como analisado              -> some da fila, continua no histórico
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// my-repo.json é resolvido pelo cwd; isola o teste num diretório descartável
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myrepo-'));
process.chdir(tmp);

const { capturarLinks, listarLinks, marcarLink, extrairLinks, chaveDe } = await import('../src/myrepo.js');

let falhas = 0;
function ok(condicao, descricao) {
  console.log(`${condicao ? '  ok  ' : ' FALHA'} ${descricao}`);
  if (!condicao) falhas++;
}

// 1. pontuação grudada no fim não faz parte da URL
ok(
  extrairLinks('olha isso https://github.com/user/repo.')[0] === 'https://github.com/user/repo',
  'apara o ponto final colado na URL',
);

// 2. vários links numa mensagem só
const dois = capturarLinks('https://github.com/a/b e https://youtu.be/xyz');
ok(dois.length === 2, 'guarda os dois links da mesma mensagem');
ok(dois[0].tipo === 'repo' && dois[1].tipo === 'video', 'classifica repo e vídeo pelo domínio');

// 3. repetir a mesma URL não duplica
const repetido = capturarLinks('https://github.com/a/b de novo');
ok(repetido.length === 0, 'URL repetida não entra outra vez');
ok(listarLinks('todos').length === 2, 'fila continua com 2 itens depois da repetição');

// 4. o texto ao redor do link vira nota
const comNota = capturarLinks('usar isso no pipeline de cortes https://exemplo.com/post', { autor: 'Luis' });
ok(comNota[0].nota === 'usar isso no pipeline de cortes', 'texto sem a URL vira a nota');
ok(comNota[0].autor === 'Luis', 'guarda quem mandou');
ok(comNota[0].tipo === 'site', 'domínio desconhecido é site');

// 5. mensagem sem link não cria entrada
ok(capturarLinks('bom dia').length === 0, 'mensagem sem link não vira item');
ok(capturarLinks(null).length === 0, 'mensagem vazia não quebra');
ok(listarLinks('todos').length === 3, 'fila segue com 3 itens');

// 6. marcar por posição tira da fila, mas não do histórico
const marcado = marcarLink('1', 'analisado');
ok(marcado?.url === 'https://github.com/a/b', 'marca o 1º da fila pela posição');
ok(listarLinks('novo').length === 2, 'analisado sai da fila de novos');
ok(listarLinks('todos').length === 3, 'analisado continua no histórico');
ok(marcarLink('https://naoexiste.com') === null, 'chave inexistente devolve null');

// persistência: outro processo (o CLI) lê o mesmo arquivo
const emDisco = JSON.parse(fs.readFileSync(path.join(tmp, 'my-repo.json'), 'utf8'));
ok(emDisco.length === 3, 'my-repo.json tem os 3 itens em disco');

// 7. arquivo corrompido não pode virar fila vazia: zerar em silêncio apagaria
// todo o histórico na próxima gravação
const arquivo = path.join(tmp, 'my-repo.json');
const intacto = fs.readFileSync(arquivo, 'utf8');
fs.writeFileSync(arquivo, '[{"url": "https://truncado.com"');
let estourou = false;
try {
  capturarLinks('https://novo.com');
} catch {
  estourou = true;
}
ok(estourou, 'JSON corrompido estoura em vez de zerar a fila');
ok(fs.readFileSync(arquivo, 'utf8').startsWith('[{"url": "https://truncado.com"'), 'arquivo corrompido não foi sobrescrito');
fs.writeFileSync(arquivo, intacto);
ok(listarLinks('todos').length === 3, 'fila volta ao normal com o arquivo restaurado');

// 8. o mesmo link compartilhado por caminhos diferentes é UM link.
// O WhatsApp e o Instagram grudam utm/igshid ao compartilhar; sem normalizar,
// a fila enche de duplicata do mesmo endereço.
ok(
  chaveDe('https://www.github.com/a/b/?utm_source=whatsapp#readme') === chaveDe('https://github.com/a/b'),
  'www, barra final, hash e utm não mudam a identidade do link',
);
ok(
  chaveDe('https://youtu.be/xyz?t=42') !== chaveDe('https://youtu.be/xyz'),
  'o t= do YouTube é conteúdo e continua diferenciando',
);
ok(capturarLinks('https://github.com/a/b?utm_source=whatsapp').length === 0, 'variante com utm não duplica na fila');
ok(capturarLinks('https://www.github.com/a/b/').length === 0, 'variante com www e barra não duplica na fila');
ok(
  capturarLinks('https://novo.dev/x e https://novo.dev/x/?utm_source=ig').length === 1,
  'duas variantes na MESMA mensagem entram uma vez só',
);
ok(marcarLink('https://novo.dev/x/?utm_source=ig', 'analisado')?.url === 'https://novo.dev/x', 'marca pela variante do link');

// O caso que importa de verdade: o link entrou SUJO (foi o primeiro a chegar,
// com utm) e depois chega limpo. Comparar só a URL crua guardada deixa passar.
ok(capturarLinks('https://sujo.dev/y?utm_source=whatsapp&igshid=123').length === 1, 'primeiro link entra com os parâmetros que veio');
ok(capturarLinks('https://sujo.dev/y').length === 0, 'link limpo não duplica o que entrou sujo');
ok(capturarLinks('https://www.sujo.dev/y/?utm_campaign=outra').length === 0, 'terceira variante também não duplica');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(falhas === 0 ? '\nTodos os casos passaram.' : `\n${falhas} caso(s) falharam.`);
process.exit(falhas === 0 ? 0 : 1);
