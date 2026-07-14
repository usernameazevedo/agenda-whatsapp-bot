// Transcrição local de mensagens de voz via whisper.cpp (sem custo de API).
// Recebe o base64 do WhatsApp (ogg/opus), converte para WAV 16k mono com
// ffmpeg e roda o whisper-cli. Retorna o texto ou null se indisponível.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG } from './config.js';
import { LOCALE } from './i18n.js';

const exec = promisify(execFile);

const WHISPER_BIN = CONFIG.whisperBin ?? '/opt/homebrew/bin/whisper-cli';
const WHISPER_MODELO = CONFIG.whisperModelo ?? path.join(os.homedir(), 'claude/whisper-models/ggml-large-v3-turbo.bin');
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const TIMEOUT_MS = 120 * 1000;

export const audioDisponivel =
  fs.existsSync(WHISPER_BIN) && fs.existsSync(WHISPER_MODELO) && fs.existsSync(FFMPEG);

export async function transcreverAudio(base64) {
  if (!audioDisponivel) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-audio-'));
  const ogg = path.join(dir, 'voz.ogg');
  const wav = path.join(dir, 'voz.wav');
  try {
    fs.writeFileSync(ogg, Buffer.from(base64, 'base64'));
    await exec(FFMPEG, ['-y', '-i', ogg, '-ar', '16000', '-ac', '1', wav], { timeout: TIMEOUT_MS });
    const { stdout } = await exec(
      WHISPER_BIN,
      ['-m', WHISPER_MODELO, '-l', LOCALE === 'en' ? 'en' : 'pt', '-f', wav, '--no-timestamps', '-np'],
      { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
    );
    const texto = stdout.replace(/\s+/g, ' ').trim();
    return texto || null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
