// Lembretes recorrentes mensais com escalação de insistência.
// Padrão de disparo, por lembrete:
//   • 2 dias antes do dia-alvo: 1x no dia (09:00)
//   • 1 dia antes:              2x no dia (09:00 e 18:00)
//   • no dia-alvo:              de hora em hora (08:00–22:00) até dar baixa
// A baixa é dada por uma frase que o usuário escolhe (ex.: "paguei o cartão").
import fs from 'node:fs';
import path from 'node:path';

const ARQUIVO = path.resolve('recorrentes.json');
const DIA_MS = 24 * 60 * 60 * 1000;

const HORAS_2_DIAS_ANTES = [9];
const HORAS_1_DIA_ANTES = [9, 18];
const DIA_DO_INICIO = 8;  // primeira hora de disparo no dia-alvo
const DIA_DO_FIM = 22;    // última hora de disparo no dia-alvo

const STOPWORDS = new Set([
  'o', 'a', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'e',
  'um', 'uma', 'no', 'na', 'pro', 'pra', 'meu', 'minha', 'ja',
]);

function carregar() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
  } catch {
    return [];
  }
}

function salvar(lista) {
  fs.writeFileSync(ARQUIVO, JSON.stringify(lista, null, 2));
}

function normalizar(t) {
  return String(t)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function palavrasSignificativas(frase) {
  return normalizar(frase).split(' ').filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function combina(mensagem, checkFrase) {
  const alvo = palavrasSignificativas(checkFrase);
  if (alvo.length === 0) return false;
  const msg = new Set(normalizar(mensagem).split(' '));
  return alvo.every((w) => msg.has(w));
}

// clampa o dia ao último dia válido do mês de referência (ex.: dia 31 em fevereiro)
function alvoDoMes(diaDoMes, ref) {
  const ultimoDia = new Date(ref.getFullYear(), ref.getMonth() + 1, 0).getDate();
  const d = new Date(ref.getFullYear(), ref.getMonth(), Math.min(diaDoMes, ultimoDia));
  d.setHours(0, 0, 0, 0);
  return d;
}

function inicioDeHoje() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const isoDia = (d) => d.toISOString().slice(0, 10);

// ciclo ativo: hoje está entre (alvo - 2 dias) e o alvo, olhando mês atual e próximo
function cicloAtivo(diaDoMes, hoje = inicioDeHoje()) {
  for (const offset of [0, 1]) {
    const ref = new Date(hoje.getFullYear(), hoje.getMonth() + offset, 1);
    const alvo = alvoDoMes(diaDoMes, ref);
    const diasAte = Math.round((alvo - hoje) / DIA_MS);
    if (diasAte >= 0 && diasAte <= 2) return { alvo, diasAte };
  }
  return null;
}

// próximo alvo em ou após hoje (para dar baixa antecipada)
function proximoAlvo(diaDoMes, hoje = inicioDeHoje()) {
  const esteMes = alvoDoMes(diaDoMes, hoje);
  if (esteMes >= hoje) return esteMes;
  const ref = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1);
  return alvoDoMes(diaDoMes, ref);
}

export function criarRecorrente({ titulo, diaDoMes, checkFrase }) {
  const lista = carregar();
  const r = {
    id: Date.now().toString(36),
    titulo,
    diaDoMes,
    checkFrase: checkFrase.trim(),
    ultimoCheckAlvo: null,
  };
  lista.push(r);
  salvar(lista);
  return r;
}

export function listarRecorrentes() {
  return carregar();
}

export function removerRecorrente(id) {
  salvar(carregar().filter((r) => r.id !== id));
}

// Tenta dar baixa: se a mensagem casa com a frase de check de algum lembrete,
// marca o próximo alvo como quitado e retorna o lembrete. Senão retorna null.
export function tentarCheck(mensagem) {
  const lista = carregar();
  const r = lista.find((x) => combina(mensagem, x.checkFrase));
  if (!r) return null;
  r.ultimoCheckAlvo = isoDia(proximoAlvo(r.diaDoMes));
  salvar(lista);
  return r;
}

function montarMensagem(r, diasAte) {
  if (diasAte === 2) return `📌 Lembrete: faltam 2 dias para *${r.titulo}* (dia ${r.diaDoMes}).`;
  if (diasAte === 1) return `⏰ *${r.titulo}* é amanhã (dia ${r.diaDoMes}). Não esquece!`;
  return `🚨 HOJE é dia de *${r.titulo}*!\nQuando fizer, me manda "${r.checkFrase}" que eu paro de avisar.`;
}

function horasDeEnvio(diasAte) {
  if (diasAte === 2) return HORAS_2_DIAS_ANTES;
  if (diasAte === 1) return HORAS_1_DIA_ANTES;
  const arr = [];
  for (let h = DIA_DO_INICIO; h <= DIA_DO_FIM; h++) arr.push(h);
  return arr;
}

// Chamado de hora em hora: devolve as mensagens a disparar nesta hora.
export function lembretesParaAgora(horaAtual) {
  const hoje = inicioDeHoje();
  const mensagens = [];
  for (const r of carregar()) {
    const ciclo = cicloAtivo(r.diaDoMes, hoje);
    if (!ciclo) continue;
    if (r.ultimoCheckAlvo === isoDia(ciclo.alvo)) continue; // já quitado neste ciclo
    if (!horasDeEnvio(ciclo.diasAte).includes(horaAtual)) continue;
    mensagens.push(montarMensagem(r, ciclo.diasAte));
  }
  return mensagens;
}
