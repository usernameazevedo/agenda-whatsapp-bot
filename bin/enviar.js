#!/usr/bin/env node
// Enviar pelo WhatsApp usando só o NOME de quem recebe.
//
//   node bin/enviar.js "Paola" "texto da mensagem" [arquivo1 arquivo2 ...]
//   node bin/enviar.js "marketing macahé" "" foto.jpg        # só arquivo, sem texto
//   node bin/enviar.js "55<DDD><número>" "texto"             # número direto também vale
//   node bin/enviar.js --quem "gabi"                          # só resolve, não envia
//   node bin/enviar.js --lista                                # relação de contatos e grupos
//
// O nome é procurado em contatos.json (contatos e grupos, com apelidos). Se
// não estiver lá, procura nos Contatos do Mac e MOSTRA os candidatos sem
// enviar: número que nunca recebeu nada pelo bot entra na relação primeiro,
// para não mandar material de cliente para a pessoa errada.
//
// Onde o bot mora vem de .bot-remoto (igual ao bin/bot). No servidor, os
// arquivos sobem por scp para ~/agenda-whatsapp/envios/<slug>/ e o item entra
// no outbox.json de lá com o caminho do container (/app/envios/...). Sem
// .bot-remoto, tudo fica local. No fim, espera o bot confirmar no log.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, spawnSync } from 'child_process';

const RAIZ = path.resolve(new URL('..', import.meta.url).pathname);
const CONTATOS = path.join(RAIZ, 'contatos.json');
const ARQ_REMOTO = path.join(RAIZ, '.bot-remoto');
const DIR_REMOTO = '~/agenda-whatsapp';
const ESPERA_MAX_S = 60;

function sair(msg, codigo = 1) {
  console.error(msg);
  process.exit(codigo);
}

// mesma normalização tolerante do bot: sem acento, emoji, espaço, caixa
function normalizar(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9@&.]/g, '');
}

function carregarContatos() {
  if (!fs.existsSync(CONTATOS)) sair(`Não achei ${CONTATOS}. Crie a relação primeiro.`);
  return JSON.parse(fs.readFileSync(CONTATOS, 'utf8'));
}

// Procura nome em contatos e grupos. Exato (nome ou apelido) ganha de
// substring; substring só vale se der um candidato só.
function resolver(nome, base) {
  const alvo = normalizar(nome);
  if (!alvo) return { erro: 'nome vazio' };
  if (/^\d{10,15}$/.test(String(nome).replace(/\D/g, '')) && /^[\d\s()+-]+$/.test(nome)) {
    return { tipo: 'para', valor: String(nome).replace(/\D/g, ''), rotulo: 'número direto' };
  }
  const entradas = [
    ...base.contatos.map((c) => ({ ...c, tipo: 'para', valor: c.numero })),
    ...base.grupos.map((g) => ({ ...g, tipo: 'grupo', valor: g.nome })),
  ];
  const chaves = (e) => [e.nome, ...(e.apelidos ?? [])].map(normalizar);
  const exatos = entradas.filter((e) => chaves(e).includes(alvo));
  if (exatos.length === 1) return { ...exatos[0], rotulo: exatos[0].nome };
  if (exatos.length > 1) return { ambiguos: exatos };
  const parciais = entradas.filter((e) => chaves(e).some((k) => k.includes(alvo)));
  if (parciais.length === 1) return { ...parciais[0], rotulo: parciais[0].nome };
  if (parciais.length > 1) return { ambiguos: parciais };
  return { erro: 'não está em contatos.json' };
}

// Fallback: Contatos do Mac (só leitura, só para mostrar candidatos)
function buscarContatosMac(nome) {
  const bases = fs
    .readdirSync(path.join(os.homedir(), 'Library/Application Support/AddressBook/Sources'))
    .map((d) => path.join(os.homedir(), 'Library/Application Support/AddressBook/Sources', d, 'AddressBook-v22.abcddb'))
    .filter((p) => fs.existsSync(p));
  const termo = String(nome).toLowerCase().replace(/'/g, "''");
  const sql = `select coalesce(r.ZFIRSTNAME,'')||' '||coalesce(r.ZLASTNAME,'')||' | '||coalesce(r.ZORGANIZATION,'')||' | '||p.ZFULLNUMBER
    from ZABCDRECORD r join ZABCDPHONENUMBER p on p.ZOWNER=r.Z_PK
    where lower(coalesce(r.ZFIRSTNAME,'')||' '||coalesce(r.ZLASTNAME,'')||' '||coalesce(r.ZORGANIZATION,'')) like '%${termo}%'
    order by 1`;
  const linhas = [];
  for (const db of bases) {
    const r = spawnSync('sqlite3', ['-readonly', db, sql], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) linhas.push(...r.stdout.trim().split('\n'));
  }
  return [...new Set(linhas)];
}

function descrever(e) {
  if (e.tipo === 'grupo') return `grupo "${e.nome}"${e.cliente ? ` (${e.cliente})` : ''}`;
  const conf = e.confirmado ? `confirmado ${e.confirmado}` : 'NÃO confirmado: veio dos Contatos do Mac';
  return `${e.nome} ${e.numero}${e.cliente ? ` (${e.cliente}${e.papel ? `, ${e.papel}` : ''})` : ''}, ${conf}`;
}

function listar(base) {
  const porCliente = (itens) => {
    const m = new Map();
    for (const i of itens) {
      const k = i.cliente ?? '?';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(i);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };
  console.log('CONTATOS');
  for (const [cliente, itens] of porCliente(base.contatos)) {
    console.log(`  ${cliente}`);
    for (const c of itens) console.log(`    ${c.nome}  ${c.numero}  [${(c.apelidos ?? []).join(', ')}]${c.confirmado ? '' : '  (a confirmar)'}`);
  }
  console.log('GRUPOS');
  for (const [cliente, itens] of porCliente(base.grupos)) {
    console.log(`  ${cliente}`);
    for (const g of itens) console.log(`    ${g.nome}  [${(g.apelidos ?? []).join(', ')}]`);
  }
  if (base.ambiguos) {
    console.log('AMBÍGUOS (perguntar antes de enviar)');
    for (const [k, v] of Object.entries(base.ambiguos)) if (!k.startsWith('_')) console.log(`  ${k}: ${v.join(' | ')}`);
  }
}

function hostRemoto() {
  if (process.env.BOT_REMOTO) return process.env.BOT_REMOTO;
  if (fs.existsSync(ARQ_REMOTO)) return fs.readFileSync(ARQ_REMOTO, 'utf8').trim() || null;
  return null;
}

function ssh(host, cmd, input) {
  return execFileSync('ssh', [host, cmd], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] });
}

function md5Local(arq) {
  return execFileSync('md5', ['-q', arq], { encoding: 'utf8' }).trim();
}

function slugDe(texto, arquivos) {
  const base = arquivos.length ? path.basename(path.dirname(path.resolve(arquivos[0]))) : (texto || 'msg').slice(0, 30);
  const s = normalizar(base).replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '') || 'envio';
  return `${new Date().toISOString().slice(0, 10)}_${s}`;
}

// Sobe os arquivos e devolve os caminhos como o container os enxerga
function subirArquivos(host, arquivos, slug) {
  const destinoHost = `${DIR_REMOTO}/envios/${slug}`;
  ssh(host, `mkdir -p ${destinoHost}`);
  execFileSync('scp', ['-q', ...arquivos, `${host}:${destinoHost}/`], { stdio: 'inherit' });
  const remotos = ssh(host, `cd ${destinoHost} && md5sum -- ${arquivos.map((a) => JSON.stringify(path.basename(a))).join(' ')}`);
  for (const arq of arquivos) {
    const nome = path.basename(arq);
    const linha = remotos.split('\n').find((l) => l.endsWith(`  ${nome}`) || l.endsWith(` ${nome}`));
    const hashRemoto = linha?.split(/\s+/)[0];
    if (hashRemoto !== md5Local(arq)) sair(`md5 diferente depois do scp: ${nome}`);
  }
  return arquivos.map((a) => `/app/envios/${slug}/${path.basename(a)}`);
}

function enfileirar(host, item) {
  // O script inteiro vai por stdin, com o item embutido como literal JSON:
  // nada passa por argumento, então não há aspas nem \n para o shell remoto
  // estragar (foi exatamente isso que quebrou o primeiro teste).
  const script = `
    const fs = require('fs');
    const arq = process.argv[2];
    const item = ${JSON.stringify(item)};
    let fila = [];
    try { fila = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch {}
    if (!Array.isArray(fila)) fila = [];
    fila.push(item);
    fs.writeFileSync(arq, JSON.stringify(fila, null, 1));
  `;
  if (host) {
    ssh(host, 'docker exec -i agenda-whatsapp node - /app/outbox.json', script);
  } else {
    execFileSync('node', ['-', path.join(RAIZ, 'outbox.json')], { input: script });
  }
}

// Espera a fila esvaziar e mostra as linhas do log que provam o envio
function esperarConfirmacao(host, nArquivos, temTexto) {
  const inicio = Date.now();
  const lerFila = () => {
    const raw = host
      ? ssh(host, `cat ${DIR_REMOTO}/outbox.json`)
      : fs.readFileSync(path.join(RAIZ, 'outbox.json'), 'utf8');
    try { return JSON.parse(raw); } catch { return null; }
  };
  const lerLog = () => {
    if (host) return ssh(host, `docker logs --since ${ESPERA_MAX_S + 30}s agenda-whatsapp 2>&1 | grep -E "Bot respondeu|outbox:" || true`);
    const log = path.join(os.homedir(), '.pm2/logs/agenda-whatsapp-out.log');
    return fs.existsSync(log) ? execFileSync('tail', ['-n', '40', log], { encoding: 'utf8' }) : '';
  };
  while (Date.now() - inicio < ESPERA_MAX_S * 1000) {
    const fila = lerFila();
    if (Array.isArray(fila) && fila.length === 0) {
      const log = lerLog().trim().split('\n').filter(Boolean);
      const enviados = log.filter((l) => l.includes('outbox: documento enviado')).length;
      const falhas = log.filter((l) => l.includes('outbox: falha'));
      const respondeu = log.some((l) => l.includes('Bot respondeu'));
      console.log(log.slice(-(nArquivos + 3)).join('\n'));
      if (falhas.length) sair(`Bot registrou falha:\n${falhas.join('\n')}`);
      if (temTexto && !respondeu) console.log('Aviso: não vi "Bot respondeu" no log; conferir.');
      if (enviados < nArquivos) sair(`Só ${enviados} de ${nArquivos} arquivos aparecem como enviados no log.`);
      console.log(`OK: fila vazia, ${enviados} arquivo(s) enviado(s)${temTexto ? ' + texto' : ''}.`);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  }
  sair(`Passaram ${ESPERA_MAX_S}s e a fila não esvaziou. Ver: ssh ${host ?? '(local)'} docker logs agenda-whatsapp`);
}

// ---------------------------------------------------------------- main
const args = process.argv.slice(2);
const base = carregarContatos();

if (args[0] === '--lista') { listar(base); process.exit(0); }

if (args[0] === '--quem') {
  const r = resolver(args[1] ?? '', base);
  if (r.ambiguos) { console.log('Ambíguo:'); r.ambiguos.forEach((e) => console.log('  ' + descrever(e))); process.exit(2); }
  if (r.erro) {
    const mac = buscarContatosMac(args[1] ?? '');
    console.log(`Não está em contatos.json. Contatos do Mac (${mac.length}):`);
    mac.forEach((l) => console.log('  ' + l));
    process.exit(mac.length ? 2 : 1);
  }
  console.log(r.tipo === 'para' && r.rotulo === 'número direto' ? `número direto ${r.valor}` : descrever(r));
  process.exit(0);
}

const [destino, texto = '', ...arquivos] = args;
if (!destino || (!texto && arquivos.length === 0)) {
  sair('Uso: node bin/enviar.js "<nome|grupo|número>" "texto" [arquivo ...]   |   --quem "<nome>"   |   --lista');
}
for (const a of arquivos) if (!fs.existsSync(a)) sair(`Arquivo não existe: ${a}`);

const r = resolver(destino, base);
if (r.ambiguos) {
  console.error(`"${destino}" bate com mais de um. Escolha um destes (nome exato ou apelido):`);
  r.ambiguos.forEach((e) => console.error('  ' + descrever(e)));
  process.exit(2);
}
if (r.erro) {
  const mac = buscarContatosMac(destino);
  console.error(`"${destino}" não está em contatos.json. Nada foi enviado.`);
  if (mac.length) {
    console.error(`Candidatos nos Contatos do Mac (confirmar com o Luis e adicionar em contatos.json):`);
    mac.forEach((l) => console.error('  ' + l));
  } else {
    console.error('Também não achei nos Contatos do Mac.');
  }
  process.exit(2);
}

const host = hostRemoto();
const item = r.tipo === 'grupo' ? { grupo: r.valor } : { para: r.valor };
if (texto) item.texto = texto;
if (arquivos.length) {
  const slug = slugDe(texto, arquivos);
  item.arquivos = host ? subirArquivos(host, arquivos, slug) : arquivos.map((a) => path.resolve(a));
}
console.log(`Destino: ${descrever(r)}${host ? ` | bot em ${host}` : ' | bot local'}`);
enfileirar(host, item);
esperarConfirmacao(host, arquivos.length, Boolean(texto));
