#!/usr/bin/env bash
# Lança a VM ARM da Oracle esperando a capacidade aparecer.
#
# A shape VM.Standard.A1.Flex do Always Free vive esgotada em São Paulo
# ("Out of capacity for shape VM.Standard.A1.Flex in availability domain AD-1").
# Não é erro de configuração: é fila. E como São Paulo só tem um availability
# domain, não há para onde fugir — só insistir.
#
# Em vez de tentar lançar às cegas, o laço consulta o relatório de capacidade
# (barato e instantâneo) e só chama o launch quando a shape aparece AVAILABLE.
#
#   deploy/oracle-launch-retry.sh              # sonda a cada 45s
#   INTERVALO=90 deploy/oracle-launch-retry.sh # sonda a cada 90s
#
# Ao conseguir, grava OCID e IP em deploy/.oracle-instance e avisa no WhatsApp.
#
# Roda como LaunchAgent com.luisazvedo.oracle-launch-retry, cujo KeepAlive
# relança em saída != 0. Por isso TODO fim de linha previsto (sucesso, VM já
# existente, erro que precisa de humano) sai com 0: só crash de verdade deve
# fazer o launchd tentar de novo.
set -uo pipefail

export SUPPRESS_LABEL_WARNING=True

COMPARTIMENTO="ocid1.tenancy.oc1..aaaaaaaabeu6ijzpsldpqb3qlwanlzgbxd7zp6pwnfe5hcjoepphd3skcylq"
AD="lSaq:SA-SAOPAULO-1-AD-1"
SUBNET="ocid1.subnet.oc1.sa-saopaulo-1.aaaaaaaaryign66ohulvc5ivbgvxoccq2jha7vzh2mu67tewvxez7zmp74la"
IMAGEM="ocid1.image.oc1.sa-saopaulo-1.aaaaaaaav4hskmch2ikmva5wxqilujiwjsug7htb6k2silemwuzxcbwwxklq"
NOME="agenda-whatsapp"
OCPUS="${OCPUS:-1}"
MEMORIA="${MEMORIA:-6}"
# 45s é o equilíbrio medido: a 30s a consulta de capacidade esbarra no
# TooManyRequests da API de vez em quando.
INTERVALO="${INTERVALO:-45}"

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$RAIZ/deploy/oracle-launch-retry.log"
MARCADOR="$RAIZ/deploy/.oracle-instance"
CHAVE_PUB="$HOME/.ssh/id_ed25519.pub"

registrar() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" | tee -a "$LOG"; }

avisar() { "$RAIZ/bin/bot" msg "$1" >/dev/null 2>&1 || true; }

# Anota OCID e IP público da instância e avisa no WhatsApp.
concluir() {
  local ocid="$1" origem="$2" ip
  ip="$(oci compute instance list-vnics --instance-id "$ocid" \
        --query 'data[0]."public-ip"' --raw-output 2>/dev/null)"
  registrar "$origem — OCID $ocid, IP público $ip"
  printf '%s\n%s\n' "$ocid" "$ip" > "$MARCADOR"
  avisar "VM da Oracle pronta. IP: $ip"
}

# Instâncias vivas com o nome do bot. Serve de trava de idempotência: sem isso,
# um relançamento do launchd depois de um launch que criou a VM mas falhou no
# wait criaria uma SEGUNDA VM e estouraria a cota do Always Free.
instancia_existente() {
  oci compute instance list -c "$COMPARTIMENTO" --display-name "$NOME" \
    --query 'data[?"lifecycle-state"==`RUNNING` || "lifecycle-state"==`PROVISIONING` || "lifecycle-state"==`STARTING`].id | [0]' \
    --raw-output 2>/dev/null
}

touch "$LOG"
registrar "iniciando laço: A1.Flex ${OCPUS} OCPU / ${MEMORIA} GB, sondagem a cada ${INTERVALO}s"

if ja="$(instancia_existente)" && [ -n "$ja" ] && [ "$ja" != "null" ]; then
  registrar "já existe instância '$NOME' viva — nada a fazer"
  concluir "$ja" "instância já existente"
  exit 0
fi

SPEC="$(mktemp -t oci-capacidade)"
trap 'rm -f "$SPEC"' EXIT
cat > "$SPEC" <<JSON
[{"instanceShape":"VM.Standard.A1.Flex","instanceShapeConfig":{"ocpus":$OCPUS.0,"memoryInGBs":$MEMORIA.0}}]
JSON

# Devolve o status cru. Erro da CLI (token expirado, permissão revogada) NÃO
# pode se disfarçar de "sem capacidade": vira ERRO e quem chama decide.
status_capacidade() {
  local saida
  saida="$(oci compute compute-capacity-report create \
    -c "$COMPARTIMENTO" --availability-domain "$AD" \
    --shape-availabilities "file://$SPEC" --no-retry \
    --query 'data."shape-availabilities"[0]."availability-status"' \
    --raw-output 2>&1)"
  if [ $? -ne 0 ]; then
    printf 'ERRO %s' "$(printf '%s' "$saida" | tr '\n' ' ' | cut -c1-200)"
  else
    printf '%s' "$saida"
  fi
}

tentativa=0
espera=0
falhas_seguidas=0
sem_rede=0

while true; do
  status="$(status_capacidade)"

  case "$status" in
    AVAILABLE)
      falhas_seguidas=0; sem_rede=0
      ;;
    ERRO*TooManyRequests*|ERRO*429*)
      # Sondar de 45 em 45s às vezes bate no limite da API. Não é problema de
      # conta e não conta como falha: é só recuar e voltar.
      registrar "sondagem levou rate limit, recuando 5 min"
      sleep 300
      continue
      ;;
    ERRO*RequestException*|ERRO*ConnectTimeout*|ERRO*ReadTimeout*|ERRO*[Cc]onnection*|ERRO*[Nn]ame\ or\ service*)
      # Sem rede. Na prática isso é o MacBook dormindo (Maintenance Sleep na
      # bateria), não problema de conta — não pode contar como falha fatal,
      # senão uma noite de sono fecha o laço. Só esperar a máquina voltar.
      sem_rede=$((sem_rede + 1))
      [ $((sem_rede % 10)) -eq 1 ] && registrar "sem rede ($sem_rede) — provavelmente o Mac dormiu, aguardando"
      sleep 120
      continue
      ;;
    ERRO*)
      falhas_seguidas=$((falhas_seguidas + 1))
      registrar "sondagem falhou ($falhas_seguidas): $status"
      # Aqui só sobra erro de conta mesmo: credencial, permissão, política.
      # Isso nenhuma espera resolve, então para e chama o humano.
      if [ "$falhas_seguidas" -ge 5 ]; then
        registrar "5 sondagens seguidas com erro de conta — parando para revisão humana"
        avisar "Laço da Oracle parou: erro de credencial ou permissão. Ver deploy/oracle-launch-retry.log"
        exit 0
      fi
      sleep "$INTERVALO"
      continue
      ;;
    *)
      falhas_seguidas=0; sem_rede=0
      espera=$((espera + 1))
      # Um registro a cada 20 sondagens para o log não virar ruído.
      [ $((espera % 20)) -eq 1 ] && registrar "sondagem $espera: $status"
      sleep "$INTERVALO"
      continue
      ;;
  esac

  espera=0
  tentativa=$((tentativa + 1))
  registrar "capacidade AVAILABLE — tentando lançar (tentativa $tentativa)"

  saida="$(oci compute instance launch \
    --compartment-id "$COMPARTIMENTO" \
    --availability-domain "$AD" \
    --display-name "$NOME" \
    --image-id "$IMAGEM" \
    --shape VM.Standard.A1.Flex \
    --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEMORIA}" \
    --subnet-id "$SUBNET" \
    --assign-public-ip true \
    --ssh-authorized-keys-file "$CHAVE_PUB" \
    --no-retry \
    --wait-for-state RUNNING \
    --wait-interval-seconds 10 2>&1)"
  codigo=$?

  if [ $codigo -eq 0 ]; then
    ocid="$(printf '%s' "$saida" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])' 2>/dev/null)"
    concluir "$ocid" "SUCESSO na tentativa $tentativa"
    exit 0
  fi

  # A janela pode fechar entre a sondagem e o launch: outra conta pegou a vaga.
  if printf '%s' "$saida" | grep -qi 'out of capacity\|out of host capacity'; then
    registrar "tentativa $tentativa: a vaga fechou antes do launch, voltando a sondar"
    sleep 5
    continue
  fi

  if printf '%s' "$saida" | grep -qi 'TooManyRequests\|429'; then
    registrar "tentativa $tentativa: rate limit, esperando 5 min"
    sleep 300
    continue
  fi

  # O launch pode ter criado a VM e falhado só na espera pelo RUNNING. Antes de
  # tratar como erro, conferir se a instância nasceu — senão a próxima rodada
  # criaria outra.
  if nova="$(instancia_existente)" && [ -n "$nova" ] && [ "$nova" != "null" ]; then
    registrar "o launch reportou erro mas a instância existe — seguindo com ela"
    concluir "$nova" "criada apesar do erro na tentativa $tentativa"
    exit 0
  fi

  # Erro que nenhuma espera resolve (limite de serviço, permissão, config).
  # Sai com 0 de propósito: com KeepAlive, sair 1 aqui viraria relançamento a
  # cada minuto justamente no caso que precisa de olho humano.
  registrar "tentativa $tentativa: erro inesperado, parando"
  printf '%s\n' "$saida" | tee -a "$LOG"
  avisar "Laço da Oracle parou com erro inesperado. Ver deploy/oracle-launch-retry.log"
  exit 0
done
