import { CONFIG } from './config.js';

const fmtHora = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: CONFIG.timezone,
});
const fmtDiaSemana = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  timeZone: CONFIG.timezone,
});

export function linkDoEvento(evento) {
  return (
    evento.hangoutLink ??
    evento.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ??
    null
  );
}

function isAniversario(evento) {
  return evento.eventType === 'birthday' || /anivers[áa]rio|birthday/i.test(evento.summary ?? '');
}

function linhaEvento(evento) {
  const titulo = evento.summary ?? '(sem título)';
  if (isAniversario(evento)) return `• 🎂 ${titulo}`;
  if (evento.start?.date) return `• 📌 ${titulo} (dia inteiro)`;
  const inicio = fmtHora.format(new Date(evento.start.dateTime));
  const fim = evento.end?.dateTime ? fmtHora.format(new Date(evento.end.dateTime)) : '';
  const local = evento.location ? `\n   📍 ${evento.location}` : '';
  const meet = linkDoEvento(evento);
  const link = meet ? `\n   📹 ${meet}` : '';
  return `• 🕐 ${inicio}${fim ? `–${fim}` : ''} ${titulo}${local}${link}`;
}

export function resumoDiario(eventos, data, titulo = '☀️ *Bom dia! Sua agenda de hoje*') {
  const dia = fmtDiaSemana.format(data);
  if (eventos.length === 0) {
    return `${titulo} (${dia}): agenda livre, nenhum compromisso. 🎉`;
  }
  const linhas = eventos.map(linhaEvento).join('\n');
  return `${titulo} (${dia}):\n\n${linhas}\n\nTotal: ${eventos.length} compromisso(s).`;
}

export function resumoSemanal(eventos, inicioSemana) {
  if (eventos.length === 0) {
    return '🗓️ *Resumo da semana*\n\nSemana livre, nenhum compromisso agendado. 🎉';
  }
  const aniversarios = eventos.filter(isAniversario);
  const demais = eventos.filter((e) => !isAniversario(e));

  const porDia = new Map();
  for (const evento of demais) {
    const data = new Date(evento.start?.dateTime ?? `${evento.start?.date}T12:00:00`);
    const chave = fmtDiaSemana.format(data);
    if (!porDia.has(chave)) porDia.set(chave, []);
    porDia.get(chave).push(linhaEvento(evento));
  }
  const blocos = [...porDia.entries()]
    .map(([dia, linhas]) => `*${dia.charAt(0).toUpperCase() + dia.slice(1)}*\n${linhas.join('\n')}`)
    .join('\n\n');

  let msg = `🗓️ *Resumo da semana* (${eventos.length} compromissos):\n\n${blocos}`;
  if (aniversarios.length > 0) {
    const linhas = aniversarios
      .map((e) => {
        const data = new Date(e.start?.dateTime ?? `${e.start?.date}T12:00:00`);
        return `• 🎂 ${e.summary} — ${fmtDiaSemana.format(data)}`;
      })
      .join('\n');
    msg += `\n\n*🎉 Aniversários da semana:*\n${linhas}`;
  }
  return msg;
}

export function mensagemLembrete(evento, minutos) {
  const titulo = evento.summary ?? '(sem título)';
  const local = evento.location ? `\n📍 ${evento.location}` : '';
  const meet = linkDoEvento(evento);
  const link = meet ? `\n📹 Entrar: ${meet}` : '';
  return `🔔 *${titulo}* em ${minutos} min (${fmtHora.format(new Date(evento.start.dateTime))})${local}${link}`;
}
