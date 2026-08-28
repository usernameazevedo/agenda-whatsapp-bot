// O libsignal (dependência do Baileys) escreve direto no console, ignorando o
// logger silencioso que passamos ao socket. Três dessas chamadas mandam o
// objeto de sessão junto — que carrega `privKey` — e o log do pm2 acabou com
// 168 chaves privadas em texto claro e 34 MB de dump:
//
//   session_record.js:270  console.warn("Session already closed", session)
//   session_record.js:273  console.info("Closing session:", session)
//   session_cipher.js:159  console.error("Session error:" + e, e.stack)
//
// A mensagem em si é sinal legítimo (sessão renegociando), então não dá para
// calar tudo: mantemos o texto e jogamos fora os objetos que vêm junto.
// Patch no console porque a alternativa seria editar node_modules, que some
// no próximo npm install.

const RUIDO_DE_SESSAO = /session|prekey|unhandled bucket type/i;

const original = {
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function enxugar(nivel) {
  return (...args) => {
    const [primeiro] = args;
    if (typeof primeiro === 'string' && RUIDO_DE_SESSAO.test(primeiro)) {
      original[nivel](`[libsignal] ${primeiro}`); // texto sim, dump não
      return;
    }
    original[nivel](...args);
  };
}

/** Chamar uma vez, no boot. Idempotente. */
export function silenciarLibsignal() {
  if (console.__libsignalSilenciado) return;
  console.info = enxugar('info');
  console.warn = enxugar('warn');
  console.error = enxugar('error');
  console.__libsignalSilenciado = true;
}
