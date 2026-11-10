// Vigia a caixa de entrada por e-mail da Oracle sobre custo e repassa ao
// WhatsApp. Existe porque a conta saiu do Free Trial (07/09/2026): antes ela
// era incapaz de cobrar, agora consegue, e o aviso da Oracle chega por e-mail
// (cláusula 15.2 do contrato) — que é justamente onde ele se perde.
//
// Só LEITURA de e-mail. Nada é marcado, movido, respondido ou apagado.
import fs from 'node:fs';
import { google } from 'googleapis';

// Ids já repassados, para o mesmo e-mail não virar mensagem toda hora. É
// estado DESTA máquina: fica fora do git e fora do sync (mesma lição do
// execucoes.json e do my-repo.json).
const VISTOS = new URL('../alertas-oracle.json', import.meta.url).pathname;
const LIMITE_VISTOS = 200;

// Janela de busca. Maior que o intervalo do cron de propósito: se o bot ficar
// algumas horas fora, ele ainda encontra o que chegou nesse meio-tempo, e a
// lista de vistos evita repetir.
const CONSULTA = 'newer_than:2d from:(oracle.com OR oraclecloud.com)';

// Assunto que interessa. Deixado LARGO de propósito: repassar um e-mail a mais
// custa uma notificação; perder um aviso de cobrança custa dinheiro.
const SOBRE_CUSTO =
  /fatura|invoice|billing|cobran|pagamento|payment|charge|cost|custo|budget|or[çc]amento|limite|limit|spending|overdue|vencid|suspens|cart[ãa]o|credit card|balance|saldo/i;

function lerVistos() {
  try {
    const reg = JSON.parse(fs.readFileSync(VISTOS, 'utf8'));
    return Array.isArray(reg) ? reg : [];
  } catch {
    return []; // primeira execução
  }
}

function gravarVistos(ids) {
  try {
    fs.writeFileSync(VISTOS, JSON.stringify(ids.slice(-LIMITE_VISTOS), null, 1));
  } catch (err) {
    console.error('Falha ao gravar alertas-oracle.json:', err.message);
  }
}

const cabecalho = (headers, nome) =>
  headers.find((h) => h.name?.toLowerCase() === nome)?.value ?? '';

/**
 * Procura e-mails novos da Oracle sobre custo. Devolve as mensagens prontas
 * para o WhatsApp (array vazio quando não há nada, que é o caso normal).
 */
export async function alertasDeCusto(auth) {
  const gmail = google.gmail({ version: 'v1', auth });
  const { data } = await gmail.users.messages.list({
    userId: 'me',
    q: CONSULTA,
    maxResults: 25,
    // A busca do Gmail ignora Spam e Lixeira por padrão. Um aviso de cobrança
    // classificado como spam é exatamente o que esta vigia existe para não
    // deixar passar, então aqui a busca inclui os dois.
    includeSpamTrash: true,
  });

  const encontrados = data.messages ?? [];
  if (encontrados.length === 0) return [];

  const vistos = lerVistos();
  const jaVisto = new Set(vistos);
  const novos = encontrados.filter((m) => !jaVisto.has(m.id));
  if (novos.length === 0) return [];

  const avisos = [];
  for (const { id } of novos) {
    // 'metadata' traz só os cabeçalhos: não baixamos o corpo do e-mail.
    const { data: msg } = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    });
    const headers = msg.payload?.headers ?? [];
    const assunto = cabecalho(headers, 'subject');
    const remetente = cabecalho(headers, 'from');

    vistos.push(id);
    // Marcar como visto mesmo quando não interessa: senão todo e-mail da
    // Oracle fora do tema seria reavaliado a cada hora, para sempre.
    if (!SOBRE_CUSTO.test(assunto)) continue;

    avisos.push(
      `💰 *E-mail da Oracle sobre custo*\n` +
        `${assunto}\n\n` +
        `De: ${remetente}\n` +
        `Em: ${cabecalho(headers, 'date')}\n\n` +
        `A conta está em Pay As You Go desde 07/09/2026 — confira em Billing > Cost Analysis.`,
    );
  }

  gravarVistos(vistos);
  return avisos;
}

/** O bot só liga a vigia se o token do Google tiver o escopo de leitura. */
export const gmailDisponivel = (auth) =>
  Boolean(auth?.credentials?.scope?.includes('gmail.readonly'));
