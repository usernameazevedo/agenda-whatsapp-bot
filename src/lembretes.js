import { CONFIG } from './config.js';
import { listarEventos } from './calendar.js';
import { mensagemLembrete } from './formatar.js';

const lembretesEnviados = new Set();

// Último lembrete enviado: um "ok" seco logo depois dele é baixa naquele
// evento (o lembrete é a última coisa que o bot disse). Vale por 2h, o que
// cobre o evento em si e a resposta atrasada.
const JANELA_OK_MS = 2 * 60 * 60 * 1000;
let ultimoLembrete = null; // { evento, em }

export function eventoDoUltimoLembrete() {
  if (!ultimoLembrete || Date.now() - ultimoLembrete.em > JANELA_OK_MS) return null;
  return ultimoLembrete.evento;
}

export function esquecerUltimoLembrete() {
  ultimoLembrete = null;
}

// Roda a cada minuto: avisa CONFIG.lembreteMinutos antes de cada evento com horário.
export async function verificarLembretes(auth, enviar) {
  const agora = new Date();
  const horizonte = new Date(agora.getTime() + 2 * 60 * 60 * 1000);
  const eventos = await listarEventos(auth, agora, horizonte);

  for (const evento of eventos) {
    if (!evento.start?.dateTime) continue; // ignora dia inteiro
    const inicio = new Date(evento.start.dateTime);
    for (const minutos of CONFIG.lembreteMinutos) {
      const chave = `${evento.id}:${minutos}`;
      if (lembretesEnviados.has(chave)) continue;
      const msRestante = inicio - agora;
      if (msRestante > 0 && msRestante <= minutos * 60 * 1000) {
        lembretesEnviados.add(chave);
        await enviar(mensagemLembrete(evento, Math.round(msRestante / 60000)));
        ultimoLembrete = { evento, em: Date.now() };
      }
    }
  }

  // evita crescimento infinito do Set
  if (lembretesEnviados.size > 500) lembretesEnviados.clear();
}
