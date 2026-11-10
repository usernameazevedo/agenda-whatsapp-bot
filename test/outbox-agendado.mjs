// Regressão do envio agendado: item do outbox com "quando" no futuro só sai na
// hora, e um agendado dormindo na fila NÃO pode envenenar o envio normal.
//
// Rodar:  node test/outbox-agendado.mjs
//
// Duas metades, e a segunda é a que importa:
//
//   A. src/index.js — processarOutboxInterno particiona a fila em vez de zerar
//      o arquivo. O que vence sai; o agendado FICA NO ARQUIVO, porque é o único
//      lugar onde ele sobrevive a um restart do container. Não pode ir para o
//      array `restantes` (só gravado no fim do loop, e com contador de
//      tentativas que mataria o agendamento calado). Caminho de falha e caminho
//      de espera não dividem variável: o caso 5 é exatamente isso.
//
//   B. bin/enviar.js — esperarConfirmacao dava a entrega por feita quando a
//      fila esvaziava. Com um agendamento morando no outbox.json a fila nunca
//      esvazia, então TODO envio normal passaria a esperar os 60s do
//      ESPERA_MAX_S e sair com código 1 dizendo que falhou tendo entregue.
//      Um agendamento pendente envenenava o CLI inteiro.
//
// A metade A roda o código DE VERDADE: extrai o texto da função de
// src/index.js (que não é importável, porque chama main() no fim) e o executa
// com dependências falsas. Se alguém renomear a função, o teste quebra alto em
// vez de passar vazio.
//
// Nada é enviado de verdade: a metade A não tem WhatsApp, e a metade B roda em
// modo local (BOT_REMOTO="") contra um número falso, sem bot no ar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINUTO = 60 * 1000;

let falhas = 0;
function ok(condicao, descricao, detalhe = '') {
  if (!condicao) falhas++;
  console.log(`${condicao ? 'PASSA' : 'FALHA'}  ${descricao}${!condicao && detalhe ? `\n        ${detalhe}` : ''}`);
}

// ------------------------------------------------------- A. src/index.js

// Recorta o texto de uma função de um arquivo, casando as chaves. Os template
// literals do corpo têm chaves balanceadas, então a contagem simples basta.
function corpoDaFuncao(fonte, assinatura) {
  const i = fonte.indexOf(assinatura);
  if (i < 0) throw new Error(`não achei "${assinatura}" em src/index.js (renomearam a função?)`);
  let profundidade = 0;
  for (let k = fonte.indexOf('{', i); k < fonte.length; k++) {
    if (fonte[k] === '{') profundidade++;
    else if (fonte[k] === '}' && --profundidade === 0) return fonte.slice(i, k + 1);
  }
  throw new Error('as chaves da função não fecham');
}

const CORPO = corpoDaFuncao(
  fs.readFileSync(path.join(RAIZ, 'src/index.js'), 'utf8'),
  'async function processarOutboxInterno()',
);

// Monta um processarOutboxInterno isolado: mesmo código, dependências falsas.
function montar(arquivo, { falharEm = null } = {}) {
  const enviados = [];
  const enviarPara = async (chatId, texto) => {
    if (falharEm && texto?.includes(falharEm)) throw new Error('falha simulada de envio');
    enviados.push({ chatId, texto });
  };
  const fabricar = new Function(
    'fs', 'OUTBOX', 'DRY_RUN', 'whatsapp', 'enviarPara', 'listarGrupos', 'nomeNormalizado',
    `let gruposCache = null;\n${CORPO}\nreturn processarOutboxInterno;`,
  );
  const rodar = fabricar(
    fs, arquivo, true, {}, enviarPara,
    async () => [], (s) => String(s ?? '').toLowerCase(),
  );
  return { rodar, enviados };
}

const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-agendado-'));
let n = 0;
async function cicloComFila(fila, opcoes) {
  const arquivo = path.join(dirA, `outbox-${++n}.json`);
  fs.writeFileSync(arquivo, JSON.stringify(fila, null, 1));
  const { rodar, enviados } = montar(arquivo, opcoes);
  await rodar();
  return { enviados, sobrou: JSON.parse(fs.readFileSync(arquivo, 'utf8')) };
}

const agora = Date.now();
const futuro = new Date(agora + 7 * 24 * 60 * MINUTO).toISOString();
const passado = new Date(agora - 10 * MINUTO).toISOString();

// 1. o caso do pedido: um para agora, um para a semana que vem
{
  const { enviados, sobrou } = await cicloComFila([
    { para: '1000000000001', texto: 'sai agora' },
    { para: '1000000000002', texto: 'lembrete do Johann', quando: futuro },
  ]);
  ok(enviados.length === 1 && enviados[0].texto === 'sai agora',
    '1. item sem "quando" sai no ciclo', JSON.stringify(enviados));
  ok(sobrou.length === 1 && sobrou[0].quando === futuro && sobrou[0].texto === 'lembrete do Johann',
    '1. item agendado FICA no outbox.json', JSON.stringify(sobrou));
}

// 2. atrasado ainda é válido: passou da hora, sai
{
  const { enviados, sobrou } = await cicloComFila([{ para: '1000000000003', texto: 'venceu', quando: passado }]);
  ok(enviados.length === 1, '2. "quando" no passado sai (atrasado ainda é válido)', JSON.stringify(enviados));
  ok(sobrou.length === 0, '2. e não fica sobrando no arquivo', JSON.stringify(sobrou));
}

// 3. data podre envia na hora em vez de desaparecer para sempre (NaN não é futuro)
{
  const { enviados, sobrou } = await cicloComFila([{ para: '1000000000004', texto: 'data podre', quando: 'semana que vem' }]);
  ok(enviados.length === 1 && sobrou.length === 0,
    '3. "quando" ilegível envia na hora (na dúvida envia, não some)', JSON.stringify({ enviados, sobrou }));
}

// 4. fila só com agendado: nada sai E o arquivo não é zerado
{
  const { enviados, sobrou } = await cicloComFila([{ para: '1000000000005', texto: 'só futuro', quando: futuro }]);
  ok(enviados.length === 0, '4. ciclo sem nada vencido não envia', JSON.stringify(enviados));
  ok(sobrou.length === 1, '4. e o arquivo NÃO é zerado (sobrevive a restart)', JSON.stringify(sobrou));
}

// 5. caminho de falha e caminho de espera não dividem variável: uma falha de
//    envio não pode arrastar o agendado para o contador de tentativas.
{
  const { enviados, sobrou } = await cicloComFila([
    { para: '1000000000006', texto: 'vai falhar' },
    { para: '1000000000007', texto: 'agendado intacto', quando: futuro },
  ], { falharEm: 'vai falhar' });
  const agendado = sobrou.find((i) => i.quando);
  const falhou = sobrou.find((i) => i.texto === 'vai falhar');
  ok(enviados.length === 0 && sobrou.length === 2,
    '5. falha volta para a fila sem perder o agendado', JSON.stringify(sobrou));
  ok(agendado && agendado.tentativas === undefined,
    '5. agendado não ganha contador de tentativas', JSON.stringify(agendado));
  ok(falhou && falhou.tentativas === 1,
    '5. só quem falhou ganha contador de tentativas', JSON.stringify(falhou));
}

// ------------------------------------------------------- B. bin/enviar.js
// O teste que o Linus exigiu por nome: com um agendado na fila, um envio normal
// não pode travar os 60s do ESPERA_MAX_S.

const OUTBOX = path.join(RAIZ, 'outbox.json');
const CONTATOS = path.join(RAIZ, 'contatos.json');
const backup = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const outboxOriginal = backup(OUTBOX);
const contatosOriginal = backup(CONTATOS);
const restaurar = (p, conteudo) => (conteudo === null ? fs.existsSync(p) && fs.unlinkSync(p) : fs.writeFileSync(p, conteudo));

// HOME descartável: sem o log do pm2, esperarConfirmacao aceita a fila vazia
// como prova e não tropeça em linhas de "outbox: falha" antigas do Mac.
const HOME_FALSO = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-home-'));
const agendado = { para: '1000000000008', texto: 'lembrete agendado', quando: futuro };

// Bot de mentira: tira da fila o que vence agora, exatamente como o bot faz, e
// deixa o agendado onde está.
const bot = setInterval(() => {
  try {
    const fila = JSON.parse(fs.readFileSync(OUTBOX, 'utf8'));
    const sobra = fila.filter((i) => Date.parse(i.quando) > Date.now());
    if (sobra.length !== fila.length) fs.writeFileSync(OUTBOX, JSON.stringify(sobra, null, 1));
  } catch { /* leitura no meio de uma escrita: tenta no próximo tick */ }
}, 250);

let resultado;
try {
  fs.writeFileSync(CONTATOS, JSON.stringify({
    contatos: [{ nome: 'Teste Bot', numero: '1000000000009', apelidos: ['teste-bot'], cliente: 'teste' }],
    grupos: [],
  }, null, 1));
  fs.writeFileSync(OUTBOX, JSON.stringify([agendado], null, 1));

  const inicio = Date.now();
  // spawn e não spawnSync: spawnSync trava o event loop e o bot de mentira
  // acima nunca chegaria a tirar nada da fila.
  const r = await new Promise((resolve) => {
    const filho = spawn('node', ['bin/enviar.js', 'teste-bot', 'envio normal de teste'], {
      cwd: RAIZ, env: { ...process.env, BOT_REMOTO: '', HOME: HOME_FALSO },
    });
    let saida = '';
    filho.stdout.on('data', (d) => (saida += d));
    filho.stderr.on('data', (d) => (saida += d));
    filho.on('close', (status) => resolve({ status, saida: saida.trim() }));
  });
  resultado = { s: Math.round((Date.now() - inicio) / 1000), status: r.status, saida: r.saida };
  resultado.sobrou = JSON.parse(fs.readFileSync(OUTBOX, 'utf8'));
} finally {
  clearInterval(bot);
  restaurar(OUTBOX, outboxOriginal);
  restaurar(CONTATOS, contatosOriginal);
}

ok(resultado.status === 0, `B. envio normal termina com sucesso (código ${resultado.status})`, resultado.saida);
ok(resultado.s < 20, `B. envio normal NÃO trava os 60s do ESPERA_MAX_S (levou ${resultado.s}s)`, resultado.saida);
ok(resultado.sobrou.length === 1 && resultado.sobrou[0].quando === futuro,
  'B. o agendado continua no outbox.json depois do envio normal', JSON.stringify(resultado.sobrou));
console.log(`        (${resultado.s}s, código ${resultado.status}) ${resultado.saida.split('\n').pop()}`);

console.log(`\n${falhas ? `${falhas} FALHA(S)` : 'tudo passou'}`);
process.exit(falhas ? 1 : 0);
