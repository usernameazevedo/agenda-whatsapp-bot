// Regressão do filtro de entrada de mensagens (src/whatsapp.js).
//
// Rodar:  node test/fila-offline.mjs
//
// Por que este teste existe: o filtro parece simples demais e convida a ser
// "simplificado" de volta para `if (type !== 'notify') return`. Isso reintroduz
// a perda silenciosa de tudo que chega enquanto o bot está fora do ar, porque o
// Baileys entrega a fila offline como 'append'
// (lib/Socket/messages-recv.js: `node.attrs.offline ? 'append' : 'notify'`).
//
// Os quatro sentidos de um mesmo evento, e o que se espera de cada um:
//   1. mensagem ao vivo             -> processa
//   2. resposta enviada pelo bot    -> ignora   (senão ele responde a si mesmo)
//   3. histórico anterior à parada  -> ignora   (senão reexecuta comando velho)
//   4. fila offline durante a parada-> PROCESSA (o defeito que isto protege)
//   5. mesma mensagem duas vezes    -> processa uma vez só
import { WhatsApp } from '../src/whatsapp.js';

const MINUTO = 60 * 1000;
const agora = Date.now();
const paradaComecou = agora - 60 * MINUTO;

function novaInstancia() {
  const zap = new WhatsApp();
  const recebidas = [];
  zap.on('message', (m) => recebidas.push(m));
  zap.definirMarcoOffline(paradaComecou);
  return { zap, recebidas };
}

function mensagem({ id, quando, texto = 'lista' }) {
  return {
    key: { id, remoteJid: '40729241989229@lid', fromMe: true, participant: '' },
    message: { conversation: texto },
    messageTimestamp: Math.floor(quando / 1000),
  };
}

// emitir() é assíncrono (Promise.resolve().then), então damos uma volta no
// event loop antes de conferir o que chegou.
const proximoCiclo = () => new Promise((r) => setTimeout(r, 10));

const resultados = [];
function conferir(nome, esperado, obtido) {
  const ok = esperado === obtido;
  resultados.push(ok);
  console.log(`${ok ? 'PASSA' : 'FALHA'}  ${nome}  (esperado ${esperado}, obtido ${obtido})`);
}

{
  const { zap, recebidas } = novaInstancia();
  zap.aoReceberMensagens({ type: 'notify', messages: [mensagem({ id: 'A1', quando: agora })] });
  await proximoCiclo();
  conferir('1. mensagem ao vivo é processada', 1, recebidas.length);
}

{
  const { zap, recebidas } = novaInstancia();
  zap.idsEnviados.add('B1'); // como se sendMessage tivesse acabado de enviar
  zap.aoReceberMensagens({ type: 'append', messages: [mensagem({ id: 'B1', quando: agora })] });
  await proximoCiclo();
  conferir('2. resposta do próprio bot é ignorada', 0, recebidas.length);
}

{
  const { zap, recebidas } = novaInstancia();
  const velha = mensagem({ id: 'C1', quando: paradaComecou - 120 * MINUTO });
  zap.aoReceberMensagens({ type: 'append', messages: [velha] });
  await proximoCiclo();
  conferir('3. histórico anterior à parada é ignorado', 0, recebidas.length);
}

{
  const { zap, recebidas } = novaInstancia();
  const durante = mensagem({ id: 'D1', quando: paradaComecou + 10 * MINUTO });
  zap.aoReceberMensagens({ type: 'append', messages: [durante] });
  await proximoCiclo();
  conferir('4. mensagem da fila offline é processada', 1, recebidas.length);
}

{
  const { zap, recebidas } = novaInstancia();
  const m = mensagem({ id: 'E1', quando: agora });
  zap.aoReceberMensagens({ type: 'notify', messages: [m] });
  await proximoCiclo();
  zap.aoReceberMensagens({ type: 'append', messages: [m] });
  await proximoCiclo();
  conferir('5. mesma mensagem não é processada duas vezes', 1, recebidas.length);
}

const falhas = resultados.filter((ok) => !ok).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} passaram`);
process.exit(falhas ? 1 : 0);
