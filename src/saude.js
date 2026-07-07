import { exec } from 'node:child_process';
import { t } from './i18n.js';

// Notificação nativa do macOS — usada quando o WhatsApp cai ou o Google falha,
// já que nesses casos não dá pra avisar pelo próprio WhatsApp.
export function notificarMac(titulo, texto) {
  const tit = String(titulo).replace(/"/g, '\\"');
  const x = String(texto).replace(/"/g, '\\"');
  exec(`osascript -e 'display notification "${x}" with title "${tit}" sound name "Basso"'`);
}

let falhasGoogle = 0;

export function registrarErroGoogle(err) {
  falhasGoogle += 1;
  console.error(`[saude] Erro Google (${falhasGoogle} seguidas):`, err.message);
  if (falhasGoogle === 3) {
    notificarMac('Agenda WhatsApp', t('notif.google'));
  }
}

export function registrarSucessoGoogle() {
  falhasGoogle = 0;
}
