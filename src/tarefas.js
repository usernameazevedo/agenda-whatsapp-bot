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

// ─── destaque das tarefas da secretária ──────────────────────────────────────
// Tarefas que citam o nome dela ("pedir para Júlia", "Júlia:", "conferir com a
// Júlia") ganham marcador e negrito para saltar aos olhos na lista do dia.
const MARCA_SECRETARIA = '👩‍💼';

const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Fronteira de palavra evita marcar "Juliana"/"Juliano" por engano.
const REGEX_SECRETARIA = CONFIG.secretariaNome
  ? new RegExp(`\\b${semAcento(CONFIG.secretariaNome).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  : null;

export function mencionaSecretaria(texto) {
  return REGEX_SECRETARIA ? REGEX_SECRETARIA.test(semAcento(texto ?? '')) : false;
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
  const linhas = doDia.map((x) => {
    const texto = mencionaSecretaria(x.texto) ? `${MARCA_SECRETARIA} *${x.texto}*` : x.texto;
    return `${x.feito ? '✅' : '❌'} ${texto}`;
  });
  const pendentes = doDia.filter((x) => !x.feito).length;
  return { lista: linhas.join('\n'), pendentes };
}

// Lista do dia. historico=true mostra ✅/❌ (visão de auditoria por data);
// historico=false agrupa pendentes e feitas em seções — o número de cada
// tarefa é estável (posição na lista do dia), então "ok 2" continua valendo.
export function formatarTarefas(data = hojeStr(), { historico = false } = {}) {
  const doDia = tarefasDoDia(data);
  if (doDia.length === 0) return null;
  const linha = (x, i) => {
    const icone = x.feito ? '✅' : historico || x.postergada ? '❌' : '⬜';
    const daSecretaria = mencionaSecretaria(x.texto);
    const texto = daSecretaria ? `${MARCA_SECRETARIA} *${x.texto}*` : x.texto;
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
    return `${i + 1}. ${icone} ${texto}${sufixo}${linhaInfo}${detalhes}${notas}`;
  };
  if (historico) return doDia.map(linha).join('\n');

  const pendentes = [];
  const feitas = [];
  doDia.forEach((x, i) => (x.feito ? feitas : pendentes).push(linha(x, i)));
  const blocos = [];
  if (pendentes.length) blocos.push(`${t('task.sec.pending')}\n${pendentes.join('\n')}`);
  if (feitas.length) blocos.push(`${t('task.sec.done')}\n${feitas.join('\n')}`);
  return blocos.join('\n\n');
}
