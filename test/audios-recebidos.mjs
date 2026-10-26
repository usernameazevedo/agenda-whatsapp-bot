// Regressão do "transcreve o último áudio do Johann" (src/audios-recebidos.js).
//
// Rodar:  node test/audios-recebidos.mjs
//
// O que importa aqui:
//   1. frases naturais de pedido -> extrai quem; conversa comum -> null
//   2. registro sobrevive ao disco com a chave de mídia intacta (Uint8Array)
//   3. busca por nome ignora acento/caixa e por número casa dígitos
//   4. áudio mais velho (fila offline fora de ordem) não sobrescreve o novo
//   5. teto de contatos descarta quem mandou áudio há mais tempo
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// audios-recebidos.json é resolvido pelo cwd; isola o teste num diretório descartável
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audios-'));
process.chdir(tmp);

const { registrarAudio, buscarUltimoAudio, pedidoDeTranscricao } = await import('../src/audios-recebidos.js');

let falhas = 0;
function ok(condicao, descricao) {
  console.log(`${condicao ? '  ok  ' : ' FALHA'} ${descricao}`);
  if (!condicao) falhas++;
}

// 1. reconhecimento do pedido
ok(pedidoDeTranscricao('escutar e transcrever o ultimo audio do Johann') === 'johann', 'frase do pedido original');
ok(pedidoDeTranscricao('Transcreve o último áudio da Ana?') === 'ana', 'acento, feminino e pontuação');
ok(pedidoDeTranscricao('ouça o áudio de 11 99887766') === '11 99887766', 'pedido por número');
ok(pedidoDeTranscricao('transcribe the last voice note from John.') === 'john', 'pedido em inglês');
ok(pedidoDeTranscricao('o Johann mandou um áudio') === null, 'menção a áudio sem verbo não é pedido');
ok(pedidoDeTranscricao('reunião com o Johann amanhã 15h') === null, 'comando de agenda não é pedido');

// 2. persistência com a chave de mídia
const chaveMidia = new Uint8Array([1, 2, 3, 250]);
const msg = (id) => ({ key: { id }, message: { audioMessage: { mediaKey: chaveMidia, directPath: '/v/x' } } });
registrarAudio({ autorId: '1001@s.whatsapp.net', chatId: '1001@s.whatsapp.net', nome: 'Jóhann Müller', hora: 2000, mensagem: msg('a') });
const achado = buscarUltimoAudio('johann');
ok(achado?.mensagem.key.id === 'a', 'acha pelo nome sem acento');
const k = achado?.mensagem.message.audioMessage.mediaKey;
ok(k && k.length === 4 && k[3] === 250 && typeof k !== 'string', 'chave de mídia volta como bytes');

// 3. número
ok(buscarUltimoAudio('1001')?.mensagem.key.id === 'a', 'acha pelo número');
ok(buscarUltimoAudio('Maria') === null, 'contato sem áudio -> null');

// 4. fora de ordem e nome ausente
registrarAudio({ autorId: '1001@s.whatsapp.net', chatId: 'x', nome: 'Johann', hora: 1000, mensagem: msg('velho') });
ok(buscarUltimoAudio('johann').mensagem.key.id === 'a', 'áudio mais velho não sobrescreve');
registrarAudio({ autorId: '1001@s.whatsapp.net', chatId: 'x', nome: null, hora: 3000, mensagem: msg('b') });
const novo = buscarUltimoAudio('johann');
ok(novo?.mensagem.key.id === 'b' && novo.nome === 'Jóhann Müller', 'novo substitui e mantém o nome conhecido');

// entre dois que casam, vence o mais recente
registrarAudio({ autorId: '1002@s.whatsapp.net', chatId: 'y', nome: 'Johann Pai', hora: 5000, mensagem: msg('pai') });
ok(buscarUltimoAudio('johann').mensagem.key.id === 'pai', 'vários casam -> mais recente');

// 5. teto de contatos
for (let i = 0; i < 105; i++) {
  registrarAudio({ autorId: `${2000 + i}@s.whatsapp.net`, chatId: 'z', nome: `Contato ${i}`, hora: 10000 + i, mensagem: msg(`c${i}`) });
}
const salvo = JSON.parse(fs.readFileSync('audios-recebidos.json', 'utf8'));
ok(Object.keys(salvo).length === 100, 'guarda no máximo 100 contatos');
ok(buscarUltimoAudio('johann') === null && buscarUltimoAudio('Contato 104') !== null, 'descarta os mais antigos');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo ok');
process.exit(falhas ? 1 : 0);
