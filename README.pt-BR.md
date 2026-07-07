# 📅 Agenda WhatsApp Bot

[🌎 English](README.md) · **🇧🇷 Português**

**Seu Google Calendar dentro do WhatsApp** — um assistente pessoal de agenda que envia resumos automáticos, lembra você das reuniões e entende pedidos em português natural, como *"marca dentista quinta às 15h"* ou *"me lembra de mandar o orçamento amanhã"*.

Roda 24/7 em um Mac, Raspberry Pi ou VPS, usando o WhatsApp que você já tem — sem API Business da Meta, sem mensalidade.

```
Você:  marca reunião com o cliente amanhã às 15h
Bot:   Marcar "Reunião com o cliente" — dom., 06/07 15:00 até 16:00. (S/N)
Você:  S
Bot:   ✅ Agendado: Reunião com o cliente — dom., 06/07 15:00
```

## ✨ O que ele faz

### Mensagens automáticas
| Quando | O quê |
|---|---|
| Todo dia às 07:00 | Resumo da agenda do dia (horários, locais, links do Meet) |
| Segunda às 07:00 | Resumo da semana agrupado por dia, com aniversários em destaque |
| Todo dia às 21:00 | Prévia da agenda de amanhã |
| 15 min antes de cada reunião | Lembrete com link do Meet pronto pra clicar |
| Todo dia às 20:00 | **Checagem do dia**: pergunta lembrete a lembrete se foi feito — "N" posterga para amanhã automaticamente |

### Comandos em linguagem natural
Fale como falaria com uma pessoa — a IA (Claude Haiku) interpreta:

- **Marcar:** *"call com o fornecedor quinta 11h"*, *"me lembra de pagar o boleto amanhã"*
- **Remarcar:** *"muda a gravação de quinta pra sexta de manhã"*
- **Cancelar:** *"cancela o dentista"*
- **Consultar:** *"o que tenho amanhã?"*, `hoje`, `semana`, `livre`
- **Lembretes mensais insistentes:** *"pagar cartão dia 10"* → cobranças crescentes (veja abaixo)

### O fluxo que evita desastres
O bot **nunca altera a agenda sem confirmação**:

1. **Coleta o que falta** — sem hora? Ele pergunta. Sem fim? Assume 1h.
2. **Desambigua** — dois eventos parecidos? Lista numerada, você escolhe.
3. **Detecta conflito de nome** — já existe "Reunião Lukas"? Pergunta: (1) marcar novo, (2) alterar o existente, (3) cancelar.
4. **Avisa dia sobrecarregado** — mais de 6h de compromissos no dia? Avisa antes do S/N.
5. **Só executa com "S"** — e "N" descarta tudo.

### Lembretes mensais insistentes
Para contas e tarefas fixas do mês. Crie em uma linha — *"pagar cartão dia 10"* — e o bot cobra com intensidade crescente até você dar baixa:

- **2 dias antes:** 1x por dia
- **1 dia antes:** 2x por dia
- **No dia:** de hora em hora (08h–22h)

Para parar, é só mandar algo com um verbo de conclusão + uma palavra do título: *"paguei o cartão"*, *"feito cartão"*. Sem frase exata pra decorar.

### Extras
- 💰 **Follow-up de orçamento:** ao marcar "enviar orçamento X", ele oferece cobrar retorno em N dias — e no dia, pergunta se houve resposta; sem resposta, cria lembrete de cobrança e sugere um texto pronto
- 👩‍💼 **Modo secretária:** um segundo número autorizado pode marcar/alterar na sua agenda (você recebe aviso de cada ação)
- 🛡️ **Watchdog de autocura:** se travar ou desconectar, reinicia sozinho com limpeza de processos órfãos
- 🔔 Notificações nativas do macOS quando algo precisa de você (sessão expirada, falha no Google)

## 🧱 Stack

| Camada | Tecnologia |
|---|---|
| WhatsApp | [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) (WhatsApp Web via Chrome headless) |
| Calendário | Google Calendar API oficial (OAuth 2.0) |
| Interpretação de frases | [Claude Haiku](https://www.anthropic.com/claude) (~US$ 0,001/mensagem; resumos automáticos não usam IA) |
| Datas em PT-BR | chrono-node |
| Agendador | node-cron |
| Processo | pm2 (auto-restart + boot) |

## 🚀 Instalação

### Pré-requisitos
- Node.js 18+ e Google Chrome instalados
- Conta Google e uma chave da [API da Anthropic](https://console.anthropic.com/) (opcional — sem ela, só os comandos fixos funcionam)

### 1. Clone e instale

```bash
git clone https://github.com/SEU_USUARIO/agenda-whatsapp-bot.git
cd agenda-whatsapp-bot
npm install
cp src/config.example.js src/config.js
# edite src/config.js com seu número
```

### 2. Credenciais do Google Calendar

1. Em [console.cloud.google.com](https://console.cloud.google.com/), crie um projeto e ative a **Google Calendar API**
2. Configure a **Tela de permissão OAuth** (tipo Externo) e adicione seu e-mail como **usuário de teste**
3. Crie um **ID do cliente OAuth** do tipo *App para computador* e baixe o JSON como `credentials.json` na raiz do projeto

### 3. Primeira execução

```bash
npm run test:daily
```

- O navegador abre para você autorizar o Google (um clique)
- Um QR code aparece (também salvo em `qr.png`) — escaneie em *WhatsApp → Aparelhos conectados*
- Você recebe o resumo do dia de teste no seu WhatsApp 🎉

### 4. Rodar para sempre

```bash
npm install -g pm2
ANTHROPIC_API_KEY=sk-ant-... pm2 start ./start.sh --name agenda-whatsapp --interpreter bash
pm2 save
pm2 startup   # siga a instrução exibida para iniciar no boot
```

> **macOS:** edite o plist gerado pelo `pm2 startup` trocando `/bin/sh -c` por `/bin/zsh -l -c` — sem shell de login, o Chrome trava na inicialização (aprendemos isso do jeito difícil, veja abaixo).

## 🔥 Lições aprendidas (para você não sofrer)

Este projeto passou por uma jornada de depuração real. Os pepinos e as soluções:

1. **QR rejeitado ("não é possível conectar novos aparelhos")** → `whatsapp-web.js` desatualizado. Sempre use `@latest`.
2. **Suas mensagens ignoradas pelo bot** → o WhatsApp migrou chats para o formato `@lid`; o ID do seu chat pode não ser `seunumero@c.us`. O log mostra o ID real — adicione em `chatsExtras`.
3. **"Execution context was destroyed" em loop** → reinícios abruptos deixam processos Chrome órfãos travando o perfil. Soluções incluídas: desligamento gracioso (SIGTERM → `destroy()`) e `start.sh` que limpa órfãos e locks antes de cada início.
4. **Trava no boot (processo "online" mas nunca conecta)** → o pm2 iniciado pelo sistema herda ambiente mínimo e o Chrome não sobe. Solução: shell de login no plist/systemd + delay de 20s.
5. **Fluxo OAuth de "colar código" não existe mais** → o Google exige redirect; este projeto sobe um servidor local em `localhost:3535` que captura a autorização sozinho.
6. **Tudo isso agora é auto-recuperável** → o watchdog interno detecta travamento/desconexão e força um renascimento limpo via pm2.

## 🌐 Idioma

O bot vem com **português e inglês**. Escolha em `src/config.js`:

```js
idioma: 'pt-BR',   // ou 'en'
```

Ou via ambiente: `BOT_LANG=en`. Troca todas as respostas, o manual, o formato de data/hora (24h vs 12h), a confirmação S/N ↔ Y/N e o prompt de interpretação da IA. Todos os textos ficam num único arquivo: `src/i18n.js`.

## ⚙️ Configuração

Tudo em `src/config.js`: idioma, horários dos resumos (cron), antecedência dos lembretes, limite de horas do dia, número da secretária, calendários incluídos. Variáveis de ambiente: `ANTHROPIC_API_KEY`, `WHATSAPP_TO`, `DAILY_HOURS_LIMIT`, `BOT_LANG`.

## 🗺️ Roadmap

- [ ] Conflito de horário sobreposto com opções (marcar assim mesmo / mudar / cancelar o outro)
- [ ] "Livre" para qualquer dia (*"tenho horário quinta de tarde?"*)
- [ ] Responder convites de reunião (aceitar/recusar) pelo WhatsApp
- [ ] Horários livres em comum entre várias pessoas
- [ ] Eventos recorrentes no calendário (com escopo "só essa / toda a série")
- [ ] Comandos por áudio (transcrição)
- [ ] Guia de deploy em Raspberry Pi / VPS

## ⚠️ Avisos

- `whatsapp-web.js` automatiza o WhatsApp Web e **não é oficial** — para uso pessoal de baixo volume é o padrão da comunidade, mas a Meta pode mudar as regras. A alternativa oficial é a WhatsApp Business Cloud API.
- Nunca commite `credentials.json`, `token.json`, `src/config.js` nem `.wwebjs_auth/` (o `.gitignore` já cuida disso).

## 📄 Licença

MIT — use, modifique e compartilhe à vontade.

---

*Construído em par com o [Claude Code](https://claude.com/claude-code) numa sessão de vibe coding que incluiu 10 bugs de produção resolvidos ao vivo.* 🤝

## Autor

Feito por **Luis Azevedo** — disponível para freelance / consultoria em vídeo, conteúdo pra redes e automação.
📬 [username.azevedo@gmail.com](mailto:username.azevedo@gmail.com)

