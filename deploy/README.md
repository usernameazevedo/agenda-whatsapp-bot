# Migração para servidor (Oracle Cloud, São Paulo)

Tira o bot do Mac e coloca numa VM ARM gratuita da Oracle. Desde a migração
para o Baileys não há navegador envolvido: o que sai do Mac é o processo Node
(38 MB) e o whisper.cpp da transcrição de áudio.

O que continua no Mac, sob demanda, via SSH: os comandos `claude:`, `ideia:`,
`relatorio`, a verificação diária das 6h e o diagnóstico das automações. Eles
dependem da CLI do Claude Code, de `~/claude/Documentos-NOXX` e do `launchctl`,
que só existem lá.

## 1. Criar a VM na Oracle

1. Conta em <https://cloud.oracle.com> (o cartão é só validação, o Always Free
   não cobra). Escolha a **região São Paulo ou Vinhedo** no cadastro: a região
   não pode ser trocada depois, e o IP brasileiro evita que o WhatsApp estranhe
   a sessão.
2. **Crie a rede antes da instância.** Se o wizard da instância criar a VCN, ele
   desabilita o botão de IP público e a VM nasce inalcançável. Em Networking →
   Virtual cloud networks → Actions → **Start VCN Wizard** → "Create VCN with
   Internet Connectivity" (nome `vcn-bot`): sai VCN, subnet pública, internet
   gateway, route table e security list de uma vez.
3. Compute → Instances → Create instance.
   - Image: **Canonical Ubuntu 24.04**, build `aarch64`
   - Shape: **VM.Standard.A1.Flex** (Ampere ARM). 1 OCPU / 6 GB já sobra para o
     bot, e A1.Flex é redimensionável depois sem recriar a VM. O Always Free vai
     até 4 OCPU / 24 GB.
   - Networking: a subnet **pública** da `vcn-bot`, com IP público automático
   - Adicione sua chave SSH pública (`~/.ssh/id_ed25519.pub`)

### "Out of host capacity"

Em São Paulo existe **um único availability domain** (`SA-SAOPAULO-1-AD-1`), então
não adianta procurar AD-2 ou AD-3: ou tem vaga, ou não tem. A shape A1 vive
esgotada e o jeito é insistir — o console não serve para isso:

```bash
deploy/oracle-launch-retry.sh          # vigia a capacidade e lança quando abrir
```

Ele exige a CLI configurada (`brew install oci-cli` + chave de API em
`~/.oci/config`). Em vez de tentar lançar às cegas, consulta o relatório de
capacidade a cada 45s e só chama o `launch` quando a shape aparece como
`AVAILABLE` — bem mais provável de pegar a janela. Grava o andamento em
`deploy/oracle-launch-retry.log`, o OCID e o IP em `deploy/.oracle-instance`, e
avisa no WhatsApp quando sobe.

Para esperar por dias sem depender do terminal aberto, instale como LaunchAgent:

```bash
cp deploy/com.luisazvedo.oracle-launch-retry.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.luisazvedo.oracle-launch-retry.plist
launchctl bootout gui/$(id -u)/com.luisazvedo.oracle-launch-retry   # para parar
```

Dois detalhes do plist que não são decoração:

- o job roda dentro de `caffeinate -s`, que segura o sono do sistema enquanto o
  laço existe e **só na tomada**. Sem isso o MacBook dorme na bateria e o
  processo congela junto: medido em 18/08, 3h42 de espera renderam ~25
  sondagens, porque o Mac passou 3h dormindo.
- `KeepAlive` só relança em saída diferente de zero, e o script sai com 0 em
  todo fim previsto. Se ele parar sozinho, é porque decidiu parar — leia o log
  antes de religar.

Para consultar a capacidade na mão, sem tentar criar nada:

```bash
oci compute compute-capacity-report create -c <tenancy-ocid> \
  --availability-domain "lSaq:SA-SAOPAULO-1-AD-1" \
  --shape-availabilities '[{"instanceShape":"VM.Standard.A1.Flex","instanceShapeConfig":{"ocpus":1.0,"memoryInGBs":6.0}}]'
```

**Plano B x86**: `VM.Standard.E2.1.Micro` (1 OCPU, 1 GB, também Always Free).
Não conte com ele de olhos fechados — em 17/08/2026 as duas shapes gratuitas
estavam esgotadas em São Paulo ao mesmo tempo, enquanto as pagas (A2.Flex,
E5.Flex) tinham vaga. Se pegar a E2.1.Micro: 1 GB sobra para o bot, mas a
compilação do whisper.cpp estoura a memória, então suba o swap para 4 GB no
`setup-servidor.sh` ou construa com `--build-arg WHISPER_MODELO=base`. O
Dockerfile já detecta a arquitetura sozinho.

Se a fila não andar de jeito nenhum, o desbloqueio conhecido é migrar a conta de
Free Trial para **Pay As You Go**: a cota Always Free continua gratuita, e contas
pagas têm prioridade na fila de capacidade ARM.

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
