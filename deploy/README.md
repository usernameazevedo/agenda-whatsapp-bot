# Migração para servidor (Oracle Cloud, São Paulo)

Tira o bot do Mac e coloca numa VM ARM gratuita da Oracle. O que sai do Mac:
o Chromium do WhatsApp Web (1,3 GB de RSS ligados 24h) e o processo Node.

O que continua no Mac, sob demanda, via SSH: os comandos `claude:`, `ideia:`,
`relatorio`, a verificação diária das 6h e o diagnóstico das automações. Eles
dependem da CLI do Claude Code, de `~/claude/Documentos-NOXX` e do `launchctl`,
que só existem lá.

## 1. Criar a VM na Oracle

1. Conta em <https://cloud.oracle.com> (o cartão é só validação, o Always Free
   não cobra). Escolha a **região São Paulo ou Vinhedo** no cadastro: a região
   não pode ser trocada depois, e o IP brasileiro evita que o WhatsApp estranhe
   a sessão.
2. Compute → Instances → Create instance.
   - Image: **Ubuntu 24.04**
   - Shape: **VM.Standard.A1.Flex** (Ampere ARM), **2 OCPU / 12 GB**
     (o Always Free foi reduzido de 4/24 para 2/12 em 15/06/2026; passar disso
     começa a cobrar)
   - Boot volume: 50 GB
   - Adicione sua chave SSH pública (`~/.ssh/id_ed25519.pub`)
3. Se aparecer "Out of host capacity", tente os outros Availability Domains
   (AD-1, AD-2, AD-3) antes de desistir: a capacidade ARM some e volta.
   Persistindo, use o **plano B x86**, que quase sempre tem vaga: shape
   `VM.Standard.E2.1.Micro` (1 OCPU, 1 GB de RAM, também Always Free). Desde o
   Baileys o bot inteiro são 38 MB de Node, então 1 GB sobra. O único ajuste é
   no build do whisper: em 1 GB a compilação do whisper.cpp estoura a memória,
   então suba o swap para 4 GB no `setup-servidor.sh` ou construa a imagem com
   `--build-arg WHISPER_MODELO=base`. O Dockerfile já detecta a arquitetura
   sozinho.

Anote o IP público e crie a entrada no `~/.ssh/config` **do Mac**:

```
Host oracle-bot
  HostName <IP-DA-VM>
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519
```

## 2. Preparar a VM

```bash
ssh oracle-bot
# copie o repositório antes ou clone do GitHub:
git clone <url-do-repo> ~/agenda-whatsapp
bash ~/agenda-whatsapp/deploy/setup-servidor.sh
exit   # sair e entrar de novo para o grupo docker valer
```

O script instala Docker, define o fuso, cria 2 GB de swap e instala o Tailscale.

## 3. Ligar o Mac e o servidor pelo Tailscale

Os comandos `claude:` / `ideia:` / `relatorio` precisam alcançar o Mac, que está
atrás do NAT da sua internet. O Tailscale resolve sem abrir porta no roteador.

No Mac:
1. Instalar o Tailscale e entrar com a mesma conta usada no servidor.
2. Ativar **Configurações → Geral → Compartilhamento → Login remoto** (SSH).

No servidor:
```bash
sudo tailscale up          # autorize no navegador
tailscale status           # anote o nome do Mac na rede
ssh-keygen -t ed25519      # se ainda não tiver chave
ssh-copy-id luisazvedo@<nome-do-mac-no-tailscale>
ssh luisazvedo@<nome-do-mac> 'echo funciona'
```

Esse nome vai no `MAC_SSH_HOST` do `.env`. Sem isso o bot funciona normalmente,
só responde que aqueles comandos específicos estão indisponíveis.

## 4. Configuração e credenciais

No servidor, dentro de `~/agenda-whatsapp`:

```bash
cp deploy/env.example .env
nano .env          # preencher ANTHROPIC_API_KEY, MAC_SSH_HOST, NTFY_TOPIC
chmod 600 .env
```

Do Mac, envie os dados e credenciais do Google (uma vez só):

```bash
cd ~/claude/agenda-whatsapp
deploy/sync.sh --com-dados
```

O `token.json` do Google continua valendo: o app GCP está publicado, então o
refresh token não expira. Se der `invalid_grant`, apague o `token.json` e
reautorize (o fluxo abre um servidor em `localhost:3535`, então rode a
reautorização no Mac e copie o `token.json` de novo).

## 5. Subir e escanear o QR

```bash
ssh oracle-bot
cd ~/agenda-whatsapp
docker compose -f deploy/docker-compose.yml up -d --build
docker logs -f agenda-whatsapp
```

O QR aparece em ASCII no log e também é salvo em `qr.png`. Para escanear pelo
celular com conforto, copie a imagem para o Mac:

```bash
scp oracle-bot:~/agenda-whatsapp/qr.png /tmp/qr.png && open /tmp/qr.png
```

O WhatsApp aceita vários aparelhos conectados: o bot novo entra como mais um.

## 6. Desligar o bot do Mac

Só depois de confirmar que o servidor respondeu a uma mensagem de teste:

```bash
pm2 stop agenda-whatsapp
pm2 delete agenda-whatsapp
pm2 save
```

Desde o Baileys não há Chromium órfão para matar: o processo Node é tudo.
A sessão do Mac (`.baileys_auth`) continua no lugar, então dá para voltar o bot
para o Mac a qualquer momento sem escanear QR de novo.

Para desfazer a migração, é o caminho inverso: `pm2 start` no Mac e
`docker compose down` no servidor. Nunca deixe os dois rodando ao mesmo tempo:
os dois leriam as mesmas mensagens e responderiam em duplicata.

## 7. Ajustar as skills do Claude

No Mac, exporte a variável (por exemplo no `~/.zshrc`):

```bash
export BOT_REMOTO=oracle-bot
```

Com ela definida, `bin/bot` manda os comandos para o container remoto:

```bash
~/claude/agenda-whatsapp/bin/bot tarefa "Ligar pro João"
~/claude/agenda-whatsapp/bin/bot msg "link publicado: ..."
```

As skills `/bot-agenda` e `/publicar-html` devem chamar `bin/bot` em vez de
`node bin/adicionar.js`.

## Operação

| o que | comando |
|---|---|
| ver logs | `ssh oracle-bot docker logs -f agenda-whatsapp` |
| reiniciar | `ssh oracle-bot 'cd ~/agenda-whatsapp && docker compose -f deploy/docker-compose.yml restart'` |
| atualizar código | `deploy/sync.sh` (no Mac) |
| backup dos dados | `scp oracle-bot:~/agenda-whatsapp/{tarefas,followups,recorrentes}.json ~/backup/` |
| uso de recursos | `ssh oracle-bot 'docker stats --no-stream'` |

## Detalhes que custam tempo se esquecidos

- **Sem navegador**: desde a migração para o Baileys não há Chromium na imagem.
  As armadilhas antigas (build do Chrome for Testing inexistente em ARM,
  `CHROME_PATH`, `shm_size: 1gb`) morreram junto e não valem mais.
- **Transcrição de áudio**: o servidor usa o modelo `small` do whisper.cpp, não
  o `large-v3-turbo` do Mac. Para trocar, rebuild com
  `--build-arg WHISPER_MODELO=medium` e ajuste o `WHISPER_MODELO` do `.env`.
- **Sessão do WhatsApp**: `.baileys_auth` nunca é sincronizado, e o `sync.sh` a
  exclui de propósito. Não é tamanho, é conflito: são credenciais de um
  aparelho linkado e o Baileys rotaciona as chaves, então duas máquinas na
  mesma sessão se derrubam com `Stream Errored (conflict)`. Cada máquina
  escaneia o seu QR.
