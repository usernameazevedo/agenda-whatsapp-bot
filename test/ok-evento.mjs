// Regressão do "ok" em evento sem IA (src/comandos.js + src/conversa.js).
//
// Rodar:  node test/ok-evento.mjs
//
// Incidente de 12/09/2026: o lembrete 🔔 "Folhas e Frutos" chegou, o Luis
// respondeu "folhas e frutos ok" e depois "ok", e as duas caíram em
// "API Claude retornou 400" (conta sem crédito). A baixa passava pela IA
// mesmo sendo frase fixa. Este teste roda com a IA desligada de propósito:
// tudo o que passa aqui funciona com a API fora do ar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.ANTHROPIC_API_KEY; // IA desligada: só o caminho sem IA responde
process.env.BOT_LANG = 'pt-BR';
// tarefas.json e recorrentes.json são resolvidos pelo cwd: isola num diretório descartável
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'ok-evento-')));

const { processarComando, lerBaixa, tituloCitado } = await import('../src/comandos.js');
const { verificarLembretes } = await import('../src/lembretes.js');
const { criarTarefa } = await import('../src/tarefas.js');

let falhas = 0;
function ok(condicao, descricao, detalhe = '') {
  if (!condicao) falhas++;
  console.log(`${condicao ? 'PASSA' : 'FALHA'}  ${descricao}${!condicao && detalhe ? `\n        ${detalhe}` : ''}`);
}

// Agenda falsa: o googleapis entrega toda chamada a auth.request(). GET lista os
// eventos; PATCH renomeia (com estado, para testar que ✅ não empilha).
function agendaFalsa(eventos) {
  const patches = [];
  const auth = {
    request: async (opts) => {
      if (opts.method === 'PATCH') {
        const id = opts.url.split('/').pop();
        const alvo = eventos.find((e) => e.id === id);
        alvo.summary = opts.data.summary;
        patches.push({ id, summary: opts.data.summary });
        return { data: alvo };
      }
      return { data: { items: [...eventos] } };
    },
  };
  return { auth, patches, eventos };
}

const daquiA = (min) => new Date(Date.now() + min * 60 * 1000).toISOString();
const evento = (id, summary, min) => ({ id, summary, start: { dateTime: daquiA(min) }, end: { dateTime: daquiA(min + 60) } });

// --- 1. leitura da frase ------------------------------------------------
ok(JSON.stringify(lerBaixa('ok')) === '{"busca":null}', '1a. "ok" seco');
ok(JSON.stringify(lerBaixa('feito')) === '{"busca":null}', '1b. "feito" seco');
ok(lerBaixa('folhas e frutos ok')?.busca === 'folhas e frutos', '1c. "<nome> ok"');
ok(lerBaixa('folhas e frutos, ok')?.busca === 'folhas e frutos', '1d. "<nome>, ok" (voz)');
ok(lerBaixa('feito a gravação')?.busca === 'a gravação', '1e. "feito <nome>"');
ok(lerBaixa('ok, mandei o documento')?.busca === 'mandei o documento', '1f. "ok, <nome>"');
ok(lerBaixa('hoje') === null, '1g. comando comum não é baixa');
ok(lerBaixa('marca reunião amanhã 15h') === null, '1h. pedido de agenda não é baixa');
ok(lerBaixa('okay') === null, '1i. "okay" não é baixa');

// --- 2. título da mensagem citada -----------------------------------------
ok(tituloCitado('🔔 *Folhas e Frutos · degustação (Marcos grava)* em 15 min (08:00)') === 'Folhas e Frutos · degustação (Marcos grava)', '2a. lembrete citado → título');
ok(tituloCitado('') === null, '2b. sem citação → null');
ok(tituloCitado('oi, tudo bem?') === null, '2c. citação sem negrito → null');

// --- 3. fluxo completo, IA desligada ---------------------------------------
const { auth, patches, eventos } = agendaFalsa([
  evento('ev-ff', 'Folhas e Frutos · degustação da milhoca na loja (Marcos grava)', 10),
  evento('ev-lucas', 'Reunião com o Lucas', 90),
]);

// 3a. lembrete sai para o evento a 10 min; "ok" citando o lembrete dá baixa nele
const enviados = [];
await verificarLembretes(auth, async (texto) => enviados.push(texto));
ok(enviados.length === 1 && enviados[0].startsWith('🔔 *Folhas e Frutos'), '3a. lembrete enviado para o evento a 10 min', JSON.stringify(enviados));

let r = await processarComando('ok', auth, 'self', { citada: enviados[0] });
ok(patches.length === 1 && patches[0].id === 'ev-ff' && patches[0].summary.startsWith('✅ Folhas'), '3b. "ok" citando o lembrete renomeia o evento com ✅', JSON.stringify(patches));
ok(r.includes('marcado como feito') && r.includes('Folhas e Frutos'), '3c. resposta confirma o evento', r);

// 3d. lembrete consumido: "ok" seco agora cai nas tarefas (nenhuma → sem pendência)
r = await processarComando('ok', auth);
ok(patches.length === 1 && r.includes('Não achei nenhuma pendência'), '3d. "ok" seco depois de consumido não mexe na agenda', r);

// 3e. "<nome> ok" acha o evento de hoje por palavras, sem lembrete e sem IA
r = await processarComando('reunião lucas ok', auth);
ok(patches.length === 2 && patches[1].id === 'ev-lucas', '3e. "reunião lucas ok" renomeia o evento', JSON.stringify(patches));

// 3f. repetir não empilha ✅: o evento já marcado sai da busca, cai na IA (desligada)
r = await processarComando('reunião lucas ok', auth);
ok(patches.length === 2 && eventos[1].summary === '✅ Reunião com o Lucas', '3f. segundo ok no mesmo evento não empilha ✅', eventos[1].summary);

// 3g. nada parecido → deixa para a IA ("orçamento Lucas ok" é outro fluxo); aqui IA desligada
r = await processarComando('orçamento riani ok', auth);
ok(r.includes('chave da API'), '3g. sem tarefa/evento parecido cai na IA', r);

// 3h. "ok" seco até 2h depois do lembrete, sem citar, dá baixa no evento do lembrete
//     mesmo havendo uma tarefa pendente (o lembrete é a última coisa que o bot disse)
eventos.push(evento('ev-bhl', 'Reunião BHL · marca DOC', 12));
criarTarefa('Ligar pro João');
await verificarLembretes(auth, async (texto) => enviados.push(texto));
ok(enviados.length === 2 && enviados[1].includes('BHL'), '3h. segundo lembrete enviado', JSON.stringify(enviados));
r = await processarComando('ok', auth);
ok(patches.length === 3 && patches[2].id === 'ev-bhl', '3i. "ok" seco logo após o lembrete renomeia o evento (não a tarefa)', JSON.stringify(patches));

// 3j. tarefa continua funcionando: "<palavras da tarefa> ok" e "ok" seco com uma pendência só
r = await processarComando('ligar joão ok', auth);
ok(r.startsWith('✅ Feita: *Ligar pro João*'), '3j. "ligar joão ok" dá check na tarefa', r);
criarTarefa('Mandar o contrato');
r = await processarComando('ok', auth);
ok(r.startsWith('✅ Feita: *Mandar o contrato*') && patches.length === 3, '3k. "ok" seco sem lembrete recente fecha a única tarefa pendente', r);

// 3l. "8 ok" continua sendo check por número (nunca vira busca por "8")
criarTarefa('Tarefa oito');
r = await processarComando('8 ok', auth);
ok(r.includes('Não achei a tarefa nº 8'), '3l. "8 ok" é check numérico', r);

console.log(falhas === 0 ? '\nTudo passou.' : `\n${falhas} falha(s).`);
process.exit(falhas === 0 ? 0 : 1);
