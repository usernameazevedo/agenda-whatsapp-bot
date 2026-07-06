// Persistência dos follow-ups de orçamento (arquivo JSON na raiz do projeto).
import fs from 'node:fs';
import path from 'node:path';

const ARQUIVO = path.resolve('followups.json');

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

export function criarFollowup({ cliente, dataEnvio, prazoDias }) {
  const lista = carregar();
  const f = {
    id: Date.now().toString(36),
    cliente,
    data_envio: dataEnvio,
    prazo_dias: prazoDias,
    status: 'pendente',
    cobrar_em: new Date(new Date(dataEnvio).getTime() + prazoDias * 24 * 60 * 60 * 1000).toISOString(),
  };
  lista.push(f);
  salvar(lista);
  return f;
}

export function paraCobrar() {
  const agora = new Date();
  return carregar().filter((f) => f.status === 'pendente' && new Date(f.cobrar_em) <= agora);
}

export function atualizarFollowup(id, patch) {
  const lista = carregar();
  const f = lista.find((x) => x.id === id);
  if (f) Object.assign(f, patch);
  salvar(lista);
  return f;
}
