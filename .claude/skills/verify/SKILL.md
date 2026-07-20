---
name: verify
description: Como rodar e verificar o agenda-whatsapp-bot neste ambiente
---

# Verificar o agenda-whatsapp-bot

- `npm install` funciona normalmente (puppeteer baixa o Chromium próprio).
- Runtime exige `src/config.js` (copie de `src/config.example.js`),
  `credentials.json` e `token.json` na raiz — para chegar só até o boot,
  arquivos dummy bastam (o Google só é chamado nos jobs).
- `node src/index.js` lança o Chromium headless e tenta `web.whatsapp.com`.
  Em ambientes remotos com proxy, a conexão falha com
  `net::ERR_TUNNEL_CONNECTION_FAILED` — e mesmo com rede, o evento `ready`
  (onde vivem TODOS os agendamentos e o handler de comandos) exige uma
  sessão WhatsApp pareada por QR no telefone do dono.
- Portanto: verificação e2e do código pós-`ready` só é possível no Mac do
  dono (pm2). Aqui, o máximo observável é o boot limpo até a tentativa de
  conexão. Reporte BLOCKED além desse ponto em vez de simular `ready`.
