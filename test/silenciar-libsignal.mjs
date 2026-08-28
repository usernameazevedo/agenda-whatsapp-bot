// Regressão do filtro de log do libsignal (src/silenciar-libsignal.js).
//
// Rodar:  node test/silenciar-libsignal.mjs
//
// Por que este teste existe: a lib manda o objeto de sessão junto da mensagem,
// e esse objeto contém `privKey`. Antes do filtro, o log do pm2 tinha 168
// chaves privadas em texto claro. O filtro precisa cortar o objeto SEM calar
// a mensagem (que é sinal real de sessão renegociando) e sem tocar em nenhum
// outro log do bot.
import { inspect } from 'node:util';

let falhas = 0;
function ok(condicao, descricao) {
  console.log(`${condicao ? '  ok  ' : ' FALHA'} ${descricao}`);
  if (!condicao) falhas++;
}

// captura o que sairia no log
const capturado = [];
const real = { info: console.info, warn: console.warn, error: console.error };
console.info = (...a) => capturado.push(a);
console.warn = (...a) => capturado.push(a);
console.error = (...a) => capturado.push(a);

// Import DEPOIS de trocar o console: o módulo guarda o console real no
// momento em que é carregado (é isso que o faz imune a quem patcheia depois),
// então importá-lo antes faria o teste capturar nada.
const { silenciarLibsignal } = await import('../src/silenciar-libsignal.js');
silenciarLibsignal();

// o objeto que a lib passa junto, no formato real (session_record.js:273)
const sessaoComChave = {
  registrationId: 1437083058,
  currentRatchet: { ephemeralKeyPair: { privKey: 'MATERIAL-SECRETO-DA-CHAVE', pubKey: 'chave-publica' } },
};

console.info('Closing session:', sessaoComChave);
console.warn('Session already closed', sessaoComChave);
console.error('Session error:Error: Bad MAC', 'stack falso aqui');
console.error('Failed to decrypt message with any known session...');
console.error('[my.repo] falha ao guardar link: disco cheio');
console.error('Erro ao processar comando:', { detalhe: 'objeto nosso preservado' });

// inspect e não String(): é assim que o console serializa de verdade, e
// String({...}) daria "[object Object]", escondendo justamente o que o teste procura
const saida = capturado.map((a) => a.map((x) => inspect(x, { depth: 6 })).join(' ')).join('\n');

ok(!saida.includes('privKey'), 'privKey não aparece no log');
ok(!saida.includes('MATERIAL-SECRETO-DA-CHAVE'), 'material da chave não aparece no log');
ok(!saida.includes('registrationId'), 'objeto de sessão inteiro foi descartado');
ok(saida.includes('Closing session:'), 'a mensagem da lib continua no log');
ok(saida.includes('[libsignal]'), 'mensagem filtrada fica marcada como da lib');
ok(saida.includes('[my.repo] falha ao guardar link: disco cheio'), 'log do bot passa intacto');
ok(saida.includes('objeto nosso preservado'), 'objeto de log NOSSO não é descartado');

// idempotência: chamar de novo não empilha wrapper
const antes = capturado.length;
silenciarLibsignal();
console.error('Session error: segunda vez');
ok(capturado.length === antes + 1, 'segunda chamada não duplica o log');

Object.assign(console, real);
console.log(falhas === 0 ? '\nTodos os casos passaram.' : `\n${falhas} caso(s) falharam.`);
process.exit(falhas === 0 ? 0 : 1);
