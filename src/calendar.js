import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { exec } from 'node:child_process';
import { google } from 'googleapis';
import { CONFIG } from './config.js';

const CREDENTIALS_PATH = path.resolve('credentials.json');
const TOKEN_PATH = path.resolve('token.json');
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
const AUTH_PORT = 3535;

function createOAuthClient() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      'credentials.json não encontrado. Baixe as credenciais OAuth no Google Cloud Console (veja README).'
    );
  }
  const { installed, web } = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const creds = installed ?? web;
  return new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    `http://localhost:${AUTH_PORT}/`
  );
}

export async function getAuthClient() {
  const client = createOAuthClient();
  if (fs.existsSync(TOKEN_PATH)) {
    client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
    return client;
  }
  const tokens = await autorizarViaNavegador(client);
  client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('Token salvo em token.json');
  return client;
}

function autorizarViaNavegador(client) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${AUTH_PORT}`);
        const code = url.searchParams.get('code');
        const erro = url.searchParams.get('error');
        if (erro) {
          res.end('Autorização negada. Pode fechar esta aba.');
          server.close();
          reject(new Error(`Autorização negada: ${erro}`));
          return;
        }
        if (!code) {
          res.end('Aguardando autorização...');
          return;
        }
        res.end('✅ Autorizado! Pode fechar esta aba e voltar ao terminal.');
        server.close();
        const { tokens } = await client.getToken(code);
        resolve(tokens);
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.listen(AUTH_PORT, () => {
      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
      });
      console.log('\nAbrindo o navegador para autorizar o Google Calendar...');
      console.log(`Se não abrir sozinho, acesse:\n${authUrl}\n`);
      exec(`open "${authUrl}"`);
    });

    server.on('error', reject);
  });
}

export async function criarEvento(auth, { titulo, inicio, fim, lembrete = false }) {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.insert({
    calendarId: CONFIG.calendarios[0] ?? 'primary',
    requestBody: {
      summary: titulo,
      start: { dateTime: inicio.toISOString(), timeZone: CONFIG.timezone },
      end: { dateTime: fim.toISOString(), timeZone: CONFIG.timezone },
      extendedProperties: lembrete ? { private: { agendaBot: 'lembrete' } } : undefined,
    },
  });
  return res.data;
}

export async function renomearEvento(auth, evento, novoTitulo) {
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.patch({
    calendarId: 'primary',
    eventId: evento.id,
    requestBody: { summary: novoTitulo },
  });
}

export async function buscarEventoPorTitulo(auth, textoBusca, diasJanela = 30) {
  const agora = new Date();
  const fim = new Date(agora.getTime() + diasJanela * 24 * 60 * 60 * 1000);
  const eventos = await listarEventos(auth, agora, fim);
  const busca = textoBusca.toLowerCase();
  return eventos.filter((e) => (e.summary ?? '').toLowerCase().includes(busca));
}

export async function deletarEvento(auth, evento) {
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({
    calendarId: 'primary',
    eventId: evento.id,
  });
}

export async function remarcarEvento(auth, evento, novoInicio) {
  const calendar = google.calendar({ version: 'v3', auth });
  const duracaoMs = evento.end?.dateTime && evento.start?.dateTime
    ? new Date(evento.end.dateTime) - new Date(evento.start.dateTime)
    : 60 * 60 * 1000;
  const novoFim = new Date(novoInicio.getTime() + duracaoMs);
  const res = await calendar.events.patch({
    calendarId: 'primary',
    eventId: evento.id,
    requestBody: {
      start: { dateTime: novoInicio.toISOString(), timeZone: CONFIG.timezone },
      end: { dateTime: novoFim.toISOString(), timeZone: CONFIG.timezone },
    },
  });
  return res.data;
}

export async function listarCalendarios(auth) {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.calendarList.list();
  return res.data.items ?? [];
}

export async function listarEventos(auth, inicio, fim) {
  const calendar = google.calendar({ version: 'v3', auth });
  const eventos = [];
  for (const calendarId of CONFIG.calendarios) {
    const res = await calendar.events.list({
      calendarId,
      timeMin: inicio.toISOString(),
      timeMax: fim.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: CONFIG.timezone,
    });
    eventos.push(...(res.data.items ?? []));
  }
  return eventos.sort((a, b) => {
    const ta = a.start?.dateTime ?? a.start?.date ?? '';
    const tb = b.start?.dateTime ?? b.start?.date ?? '';
    return ta.localeCompare(tb);
  });
}
