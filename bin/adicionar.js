#!/usr/bin/env node
// Canal de entrada externo (Claude Code, scripts): adiciona tarefas e
// compromissos direto nos mesmos dados do bot. Rodar da RAIZ do projeto
// (tarefas.json é resolvido pelo cwd).
//
//   node bin/adicionar.js tarefa "Ligar pro João" [2026-07-28]
//   node bin/adicionar.js evento "Reunião com cliente" "2026-07-28T15:00" [60]
//   node bin/adicionar.js msg "texto livre para o grupo"
//
// A confirmação chega no WhatsApp via outbox (o bot envia em até 30s).
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../src/config.js';
import { criarTarefa, formatarTarefas, hojeStr, dataCurta } from '../src/tarefas.js';

const [modo, ...args] = process.argv.slice(2);

function sair(msg, codigo = 1) {
  console.error(msg);
  process.exit(codigo);
}

// enfileira aviso no outbox do bot (grupo padrão do config)
function avisarWhatsApp(texto, grupo = CONFIG.grupo) {
  const OUTBOX = path.resolve('outbox.json');
  let fila = [];
  try { fila = JSON.parse(fs.readFileSync(OUTBOX, 'utf8')); } catch { /* fila nova */ }
  fila.push({ grupo, texto });
  fs.writeFileSync(OUTBOX, JSON.stringify(fila, null, 1));
}

if (modo === 'tarefa') {
  const [texto, data] = args;
  if (!texto) sair('Uso: node bin/adicionar.js tarefa "texto" [YYYY-MM-DD]');
  if (data && !/^\d{4}-\d{2}-\d{2}$/.test(data)) sair(`Data inválida: ${data} (use YYYY-MM-DD)`);
  const tarefa = criarTarefa(texto, data ?? hojeStr());
  avisarWhatsApp(`📝 Tarefa adicionada via Claude: *${tarefa.texto}* (${dataCurta(tarefa.data)})\n\n${formatarTarefas(tarefa.data)}`);
  console.log(`Tarefa criada para ${tarefa.data}: ${tarefa.texto}`);
} else if (modo === 'evento') {
  const [titulo, inicioStr, duracaoStr] = args;
  if (!titulo || !inicioStr) sair('Uso: node bin/adicionar.js evento "título" "YYYY-MM-DDTHH:MM" [duraçãoMin]');
  const inicio = new Date(inicioStr);
  if (Number.isNaN(inicio.getTime())) sair(`Data/hora inválida: ${inicioStr}`);
  const duracaoMin = parseInt(duracaoStr ?? '60', 10);
  if (!duracaoMin || duracaoMin < 1) sair(`Duração inválida: ${duracaoStr}`);
  const fim = new Date(inicio.getTime() + duracaoMin * 60 * 1000);
  const { getAuthClient, criarEvento } = await import('../src/calendar.js');
  const auth = await getAuthClient();
  const evento = await criarEvento(auth, { titulo, inicio, fim });
  const quando = inicio.toLocaleString('pt-BR', { timeZone: CONFIG.timezone, hour12: false });
  avisarWhatsApp(`📅 Agendado via Claude: *${titulo}* — ${quando} (${duracaoMin}min)\n${evento.htmlLink ?? ''}`);
  console.log(`Evento criado: ${titulo} — ${quando}`);
} else if (modo === 'msg') {
  // Enfileira texto livre no outbox (usado pelo /publicar-html e scripts).
  const [texto, grupo] = args;
  if (!texto) sair('Uso: node bin/adicionar.js msg "texto" ["Nome do Grupo"]');
  avisarWhatsApp(texto, grupo || CONFIG.grupo);
  console.log(`Mensagem enfileirada no outbox (grupo: ${grupo || CONFIG.grupo}).`);
} else {
  sair('Uso: node bin/adicionar.js tarefa|evento|msg ... (veja o cabeçalho do arquivo)');
}
