// Regressão do filtro da vigia de cobrança da Oracle (src/oracle-alertas.js).
//
// Rodar:  node test/oracle-alertas.mjs
//
// O que este teste protege: o filtro é deliberadamente LARGO. Repassar um
// e-mail a mais custa uma notificação; perder um aviso de cobrança custa
// dinheiro. Quem "limpar" a regex depois vai quebrar exatamente isso.
import fs from 'node:fs';

// A regex vive no módulo; lemos do arquivo para testar a de verdade, sem
// duplicar (uma cópia aqui não provaria nada sobre o código em produção).
const fonte = fs.readFileSync(new URL('../src/oracle-alertas.js', import.meta.url), 'utf8');
const linha = fonte.match(/const SOBRE_CUSTO\s*=\s*([\s\S]*?);/);
if (!linha) {
  console.log('FALHA  não achei SOBRE_CUSTO em src/oracle-alertas.js');
  process.exit(1);
}
// eslint-disable-next-line no-eval
const SOBRE_CUSTO = eval(linha[1]);

const resultados = [];
function conferir(assunto, esperado) {
  const obtido = SOBRE_CUSTO.test(assunto);
  const ok = obtido === esperado;
  resultados.push(ok);
  console.log(`${ok ? 'PASSA' : 'FALHA'}  ${esperado ? 'repassa ' : 'ignora  '} "${assunto}"`);
}

// Assuntos reais que a Oracle usa para cobrança — todos TÊM de passar.
conferir('Your Oracle Cloud Infrastructure invoice is ready', true);
conferir('Oracle Cloud Infrastructure Budget Alert', true);
conferir('Alerta de orçamento: guarda-corpo-bot', true);
conferir('Sua fatura da Oracle está disponível', true);
conferir('Payment method declined', true);
conferir('Your credit card on file will expire soon', true);
conferir('Account suspended due to overdue balance', true);
conferir('Cobrança pendente na sua conta Oracle', true);
conferir('Você atingiu o limite de gastos', true);
conferir('Monthly cost report', true);

// Assuntos da Oracle que NÃO são sobre dinheiro — não devem virar notificação.
conferir('Welcome to Oracle Cloud Infrastructure', false);
conferir('Novidades do produto: Autonomous Database', false);
conferir('Scheduled maintenance in sa-saopaulo-1', false);
conferir('Confirme seu endereço de e-mail', false);

const falhas = resultados.filter((ok) => !ok).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} passaram`);
process.exit(falhas ? 1 : 0);
