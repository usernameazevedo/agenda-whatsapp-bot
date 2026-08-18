# Situação da migração para a Oracle Cloud

Documento de contexto, fechado em 18/08/2026 12:45. Serve para retomar o
assunto sem redescobrir nada.

## O objetivo

Tirar o bot `agenda-whatsapp` do MacBook e colocar num servidor que fique
ligado 24h. Desde a migração para o Baileys o bot inteiro são 38 MB de Node
mais o whisper.cpp da transcrição de áudio, então qualquer VM modesta serve.

## Onde parou

Tudo pronto, menos a máquina. O bloqueio é **capacidade da Oracle**, não
configuração:

```
VM.Standard.A1.Flex     OUT_OF_HOST_CAPACITY   (ARM, Always Free)
VM.Standard.E2.1.Micro  OUT_OF_HOST_CAPACITY   (x86, Always Free)
VM.Standard.A2.Flex     AVAILABLE              (ARM, paga)
VM.Standard.E5.Flex     AVAILABLE              (x86, paga)
```

A região tem host livre, só não nas shapes gratuitas. Medido em 17/08 e
confirmado ao longo de 18/08 pelo relatório de capacidade da própria Oracle,
não por tentativa e erro.

Em ~13h de espera (17/08 23:19 até 18/08 12:45): 55 sondagens registradas,
**zero janelas** de capacidade abertas.

## O que já está feito

| item | estado |
|---|---|
| Conta Oracle | já existia. Tenant `usernameazevedo`, região Brazil East (São Paulo), Free Trial |
| Rede | `vcn-bot`, subnet pública, internet gateway, route table, security list |
| CLI + credencial | `oci-cli` via brew, chave RSA em `~/.oci/config` (gerada local, só a pública foi ao console) |
| Laço de espera | `deploy/oracle-launch-retry.sh` rodando como LaunchAgent |
| Instância | não existe. É o que falta |

OCIDs em uso (já embutidos no script):

- tenancy/compartimento: `ocid1.tenancy.oc1..aaaaaaaabeu6ijzpsldpqb3qlwanlzgbxd7zp6pwnfe5hcjoepphd3skcylq`
- availability domain: `lSaq:SA-SAOPAULO-1-AD-1` (é o único da região)
- subnet pública: `ocid1.subnet.oc1.sa-saopaulo-1.aaaaaaaaryign66ohulvc5ivbgvxoccq2jha7vzh2mu67tewvxez7zmp74la`
- imagem: `Canonical-Ubuntu-24.04-aarch64-2026.07.17-0`

## Custo real, se for para pagar

Preços da lista pública da Oracle (API, atualizada em 14/08/2026), em reais,
para 1 OCPU / 6 GB, 730 h/mês, sem impostos:

| opção | R$/h | R$/mês |
|---|---|---|
| A1 dentro do Always Free | 0 | **0** |
| A1 fora da cota grátis | 0,0995 | 72,62 |
| A2.Flex (tem vaga agora) | 0,1361 | 99,37 |
| E5.Flex (tem vaga agora) | 0,2199 | 160,53 |

Boot volume de 47 GB: R$ 0 dentro dos 200 GB gratuitos, R$ 6,27/mês fora.
Saída de dados: gratuita até 10 TB/mês na América do Sul.

Migrar a conta para Pay As You Go **não** cancela a faixa gratuita: a lista de
preços tem duas faixas para a A1, uma de valor zero (Always Free) e outra
paga, para o que passar da cota. O custo do PAYG não é a VM, é perder o
guarda-corpo: em Free Trial a conta não consegue cobrar, no PAYG qualquer
recurso criado fora da cota cai no cartão.

## Armadilhas já pagas (não repetir)

**Console da Oracle**

- São Paulo tem **um único availability domain**. A mensagem de erro manda
  tentar outro AD e o README antigo do projeto mandava tentar AD-1/2/3: não
  existe outro.
- Deixar o wizard da instância criar a VCN faz a VM nascer inalcançável: com
  subnet nova o toggle de IP público fica desabilitado (`aria-disabled=true`,
  `aria-checked=false`) e o review sai com "Public IPv4 address: No". Criar a
  rede antes, pelo Start VCN Wizard, resolve.
- O wizard novo não expõe slider de OCPU/memória: a A1.Flex nasce 1 OCPU / 6 GB.
  Não é problema, A1.Flex é redimensionável depois sem recriar a VM.

**CLI da Oracle**

- Faz retry interno em erro 500, e "Out of capacity" é 500. Sem `--no-retry` o
  comando fica pendurado minutos sem log nenhum.
- Sondar de 30 em 30s esbarra em `TooManyRequests`. A 45s parou de reclamar.

**Laço rodando no Mac**

- Erro de rede quase sempre é o MacBook dormindo, não problema de conta. Tratar
  como falha fatal fecha o laço numa noite de sono (aconteceu: parou às 07:16 e
  ficou 1h40 fora da fila).
- Processo vivo não significa laço trabalhando: entre 09:23 e 12:27 de 18/08 o
  processo existia e o Mac dormia, 193 minutos sem uma única sondagem. Por isso
  o LaunchAgent roda dentro de `caffeinate -s`, que segura o sono só na tomada.
- `KeepAlive` com `SuccessfulExit=false` relança em saída diferente de zero.
  Todo fim previsto do script sai com 0 de propósito, senão o abort deliberado
  vira relançamento de minuto em minuto.

## Operação

```bash
# ver a espera
tail -f ~/claude/agenda-whatsapp/deploy/oracle-launch-retry.log

# parar / religar
launchctl bootout gui/$(id -u)/com.luisazvedo.oracle-launch-retry
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.luisazvedo.oracle-launch-retry.plist

# consultar capacidade na mão
oci compute compute-capacity-report create \
  -c ocid1.tenancy.oc1..aaaaaaaabeu6ijzpsldpqb3qlwanlzgbxd7zp6pwnfe5hcjoepphd3skcylq \
  --availability-domain "lSaq:SA-SAOPAULO-1-AD-1" \
  --shape-availabilities '[{"instanceShape":"VM.Standard.A1.Flex","instanceShapeConfig":{"ocpus":1.0,"memoryInGBs":6.0}}]' \
  --query 'data."shape-availabilities"[0]."availability-status"' --raw-output
```

Quando a VM subir, o laço grava OCID e IP em `deploy/.oracle-instance`, avisa
no grupo do WhatsApp, e o resto do caminho está no `deploy/README.md` a partir
do passo 2.

## O que falta decidir

Continuar esperando a A1 é a opção em curso e custa zero. As alternativas ainda
não avaliadas, que é o assunto da próxima conversa:

1. Migrar para Pay As You Go e continuar na A1 (custo zero, some o guarda-corpo)
2. Pagar A2.Flex ou E5.Flex na Oracle (R$ 99 a R$ 160/mês)
3. Trocar de provedor: VPS barato de outro fornecedor, faixa gratuita de outra
   nuvem, ou hospedagem que já esteja paga
4. Não migrar: manter o bot no Mac e resolver só o consumo, que desde o Baileys
   já caiu de 1,3 GB para 38 MB. O motivo original da migração era o Chromium,
   que não existe mais
5. Máquina física em casa: Raspberry Pi ou qualquer computador velho ligado

A opção 4 merece atenção porque a premissa que abriu esse projeto mudou no meio
do caminho.

## Pendências independentes da VM

- Tailscale não está instalado no Mac. É o que permite os comandos `claude:`,
  `ideia:` e `relatorio` alcançarem a máquina depois da migração, e alimenta o
  `MAC_SSH_HOST` do `.env`.
