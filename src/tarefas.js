// Tarefas do dia (a fazer): persistência em tarefas.json na raiz do projeto.
// Cada tarefa pertence a um dia (YYYY-MM-DD). Check por número ("1. feito"),
// consulta por data e postergação automática das pendentes para o dia seguinte.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { t } from './i18n.js';

const ARQUIVO = path.resolve('tarefas.json');

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

// dia de hoje (YYYY-MM-DD) no fuso configurado
export function hojeStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone }).format(new Date());
}

// aceita "01/7", "01/07", "1/7/2026", "2026-07-01"; retorna YYYY-MM-DD ou null
export function normalizarData(texto) {
  const s = texto.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const dia = parseInt(m[1], 10);
  const mes = parseInt(m[2], 10);
  if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return null;
  let ano = m[3] ? parseInt(m[3], 10) : parseInt(hojeStr().slice(0, 4), 10);
  if (ano < 100) ano += 2000;
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

export function criarTarefa(texto, data = hojeStr()) {
  const lista = carregar();
  const tarefa = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    texto: texto.trim(),
    data,
    feito: false,
    feitoEm: null,
    postergada: false,
    criadoEm: new Date().toISOString(),
  };
  lista.push(tarefa);
  salvar(lista);
  return tarefa;
}

export function tarefasDoDia(data = hojeStr()) {
  return carregar()
    .filter((x) => x.data === data)
    .sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
}

export function pendentesDoDia(data = hojeStr()) {
  return tarefasDoDia(data).filter((x) => !x.feito && !x.postergada);
}

// marca a tarefa nº n (1-based na lista do dia) como feita
export function marcarFeita(n, data = hojeStr()) {
  const doDia = tarefasDoDia(data);
  const alvo = doDia[n - 1];
  if (!alvo) return null;
  const lista = carregar();
  const idx = lista.findIndex((x) => x.id === alvo.id);
  const atualizada = { ...lista[idx], feito: true, feitoEm: new Date().toISOString() };
  salvar([...lista.slice(0, idx), atualizada, ...lista.slice(idx + 1)]);
  return atualizada;
}

export function marcarFeitaPorId(id) {
  const lista = carregar();
  const idx = lista.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  const atualizada = { ...lista[idx], feito: true, feitoEm: new Date().toISOString() };
  salvar([...lista.slice(0, idx), atualizada, ...lista.slice(idx + 1)]);
  return atualizada;
}

// acrescenta uma nota (informação extra) à tarefa nº n do dia
export function adicionarNota(n, nota, data = hojeStr()) {
  const doDia = tarefasDoDia(data);
  const alvo = doDia[n - 1];
  if (!alvo) return null;
  const lista = carregar();
  const idx = lista.findIndex((x) => x.id === alvo.id);
  const atualizada = { ...lista[idx], notas: [...(lista[idx].notas ?? []), nota.trim()] };
  salvar([...lista.slice(0, idx), atualizada, ...lista.slice(idx + 1)]);
  return atualizada;
}

// busca tarefa não feita (hoje ou futura) cujo texto contém o termo
export function buscarPendentePorTexto(termo, hoje = hojeStr()) {
  const alvo = termo.toLowerCase();
  return carregar()
    .filter((x) => !x.feito && !x.postergada && x.data >= hoje && x.texto.toLowerCase().includes(alvo))
    .sort((a, b) => a.data.localeCompare(b.data));
}

export function adicionarNotaPorId(id, nota) {
  const lista = carregar();
  const idx = lista.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  const atualizada = { ...lista[idx], notas: [...(lista[idx].notas ?? []), nota.trim()] };
  salvar([...lista.slice(0, idx), atualizada, ...lista.slice(idx + 1)]);
  return atualizada;
}

// campos estruturados opcionais (horario, local, cliente, detalhes) — só
// preenchidos quando o usuário pede para acrescentar informações
const CAMPOS_INFO = ['horario', 'local', 'cliente', 'detalhes'];

export function atualizarInfoPorId(id, info) {
  const lista = carregar();
  const idx = lista.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  const limpo = {};
  for (const c of CAMPOS_INFO) {
    const v = (info?.[c] ?? '').toString().trim();
    if (v) limpo[c] = v;
  }
  const atualizada = { ...lista[idx], info: { ...(lista[idx].info ?? {}), ...limpo } };
  salvar([...lista.slice(0, idx), atualizada, ...lista.slice(idx + 1)]);
  return atualizada;
}

// Move as pendentes de dias anteriores para hoje: a original vira "postergada"
// (aparece com ❌ no histórico) e uma cópia nasce no dia de hoje.
export function postergarPendentes(hoje = hojeStr()) {
  const lista = carregar();
  const movidas = [];
  const nova = lista.map((x) => {
    if (x.data < hoje && !x.feito && !x.postergada) {
      movidas.push(x);
      return { ...x, postergada: true };
    }
    return x;
  });
  for (const x of movidas) {
    nova.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      texto: x.texto,
      notas: x.notas ?? [],
      info: x.info ?? {},
      data: hoje,
      feito: false,
      feitoEm: null,
      postergada: false,
      criadoEm: new Date().toISOString(),
    });
  }
  if (movidas.length) salvar(nova);
  return movidas.length;
}

// "DD/MM" para exibição
export function dataCurta(data) {
  const [, m, d] = data.split('-');
  return `${d}/${m}`;
}

// Fechamento do dia: lista com ✅ feito / ❌ não feito e contagem de pendentes
// (as não feitas passam automaticamente para amanhã no cron diário).
export function fechamentoDoDia(data = hojeStr()) {
  const doDia = tarefasDoDia(data);
  if (doDia.length === 0) return null;
  const linhas = doDia.map((x) => `${x.feito ? '✅' : '❌'} ${x.texto}`);
  const pendentes = doDia.filter((x) => !x.feito).length;
  return { lista: linhas.join('\n'), pendentes };
}

// Lista do dia. historico=true mostra ✅/❌ (visão de auditoria por data);
// historico=false mostra ✅/⬜ (lista de trabalho de hoje, com números para dar check).
export function formatarTarefas(data = hojeStr(), { historico = false } = {}) {
  const doDia = tarefasDoDia(data);
  if (doDia.length === 0) return null;
  const linhas = doDia.map((x, i) => {
    const icone = x.feito ? '✅' : historico || x.postergada ? '❌' : '⬜';
    const sufixo = !x.feito && x.postergada ? ` ${t('task.postponed.tag')}` : '';
    const info = x.info ?? {};
    const partes = [
      info.horario ? `🕐 ${info.horario}` : null,
      info.local ? `📍 ${info.local}` : null,
      info.cliente ? `👤 ${info.cliente}` : null,
    ].filter(Boolean);
    const linhaInfo = partes.length ? `\n   ${partes.join(' · ')}` : '';
    const detalhes = info.detalhes ? `\n   ↳ ${info.detalhes}` : '';
    const notas = (x.notas ?? []).map((nota) => `\n   ↳ ${nota}`).join('');
    return `${i + 1}. ${icone} ${x.texto}${sufixo}${linhaInfo}${detalhes}${notas}`;
  });
  return linhas.join('\n');
}
