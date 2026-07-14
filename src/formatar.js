import { t, fmtHora, fmtDiaSemana, cap } from './i18n.js';

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

export function isLembrete(evento) {
  return (
    evento.extendedProperties?.private?.agendaBot === 'lembrete' ||
    /lembrete|lembrar|cobrar|reminder|remind|chase/i.test(evento.summary ?? '')
  );
}

function linhaEvento(evento) {
  const titulo = evento.summary ?? t('event.untitled');
  if (isAniversario(evento)) return `• 🎂 ${titulo}`;
  if (evento.start?.date) return `• 📌 ${titulo} ${t('event.allday')}`;
  const inicio = fmtHora.format(new Date(evento.start.dateTime));
  const fim = evento.end?.dateTime ? fmtHora.format(new Date(evento.end.dateTime)) : '';
  const local = evento.location ? `\n   📍 ${evento.location}` : '';
  const meet = linkDoEvento(evento);
  const link = meet ? `\n   📹 ${meet}` : '';
  return `• 🕐 ${inicio}${fim ? `–${fim}` : ''} ${titulo}${local}${link}`;
}

// Resumo segmentado: aniversários no topo, depois compromissos, lembretes
// e (opcional) as tarefas do dia passadas em tarefasTexto.
export function resumoDiario(eventos, data, titulo = t('daily.title.morning'), tarefasTexto = null) {
  const dia = fmtDiaSemana.format(data);
  if (eventos.length === 0 && !tarefasTexto) {
    return t('daily.empty', { title: titulo, day: dia });
  }

  const aniversarios = eventos.filter(isAniversario);
  const lembretes = eventos.filter((e) => !isAniversario(e) && isLembrete(e));
  const compromissos = eventos.filter((e) => !isAniversario(e) && !isLembrete(e));

  const blocos = [];
  if (aniversarios.length) {
    blocos.push(`${t('daily.sec.birthdays')}\n${aniversarios.map(linhaEvento).join('\n')}`);
  }
  if (compromissos.length) {
    blocos.push(`${t('daily.sec.events')}\n${compromissos.map(linhaEvento).join('\n')}`);
  }
  if (lembretes.length) {
    blocos.push(`${t('daily.sec.reminders')}\n${lembretes.map(linhaEvento).join('\n')}`);
  }
  if (tarefasTexto) {
    blocos.push(`${t('daily.sec.tasks')}\n${tarefasTexto}\n${t('daily.sec.tasks.hint')}`);
  }
  if (blocos.length === 0) return t('daily.empty', { title: titulo, day: dia });

  return `${titulo} (${dia}):\n\n${blocos.join('\n\n')}\n\n${t('daily.total', { n: eventos.length })}`;
}

export function resumoSemanal(eventos, inicioSemana) {
  if (eventos.length === 0) return t('week.empty');
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
    .map(([dia, linhas]) => `*${cap(dia)}*\n${linhas.join('\n')}`)
    .join('\n\n');

  let msg = `${t('week.title', { n: eventos.length })}\n\n${blocos}`;
  if (aniversarios.length > 0) {
    const linhas = aniversarios
      .map((e) => {
        const data = new Date(e.start?.dateTime ?? `${e.start?.date}T12:00:00`);
        return `• 🎂 ${e.summary} — ${fmtDiaSemana.format(data)}`;
      })
      .join('\n');
    msg += `\n\n${t('week.birthdays')}\n${linhas}`;
  }
  return msg;
}

export function mensagemLembrete(evento, minutos) {
  const titulo = evento.summary ?? t('event.untitled');
  const local = evento.location ? `\n📍 ${evento.location}` : '';
  const meet = linkDoEvento(evento);
  const link = meet ? `\n📹 ${t('reminder.join')}${meet}` : '';
  return t('reminder.in', {
    title: titulo,
    min: minutos,
    time: fmtHora.format(new Date(evento.start.dateTime)),
    loc: local,
    link,
  });
}
