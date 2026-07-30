import { exec } from 'node:child_process';
import { CONFIG } from './config.js';
import { NO_MAC } from './exec.js';
import { t } from './i18n.js';

// Alerta de infraestrutura — usado quando o WhatsApp cai ou o Google falha,
// já que nesses casos não dá pra avisar pelo próprio WhatsApp.
// No Mac: notificação nativa. No servidor: ntfy.sh (se configurado) + log.
export function notificar(titulo, texto) {
  console.error(`[saude] ${titulo}: ${texto}`);

  if (NO_MAC) {
    const tit = String(titulo).replace(/"/g, '\\"');
    const x = String(texto).replace(/"/g, '\\"');
    exec(`osascript -e 'display notification "${x}" with title "${tit}" sound name "Basso"'`);
    return;
  }

  if (!CONFIG.ntfyTopic) return;
  fetch(`https://ntfy.sh/${CONFIG.ntfyTopic}`, {
    method: 'POST',
    body: String(texto),
    headers: { Title: String(titulo), Priority: 'high', Tags: 'warning' },
  }).catch((err) => console.error('[saude] falha ao enviar ntfy:', err.message));
}

let falhasGoogle = 0;

export function registrarErroGoogle(err) {
  falhasGoogle += 1;
  console.error(`[saude] Erro Google (${falhasGoogle} seguidas):`, err.message);
  if (falhasGoogle === 3) {
    notificar('Agenda WhatsApp', t('notif.google'));
  }
}

export function registrarSucessoGoogle() {
  falhasGoogle = 0;
}
