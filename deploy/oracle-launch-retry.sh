#!/usr/bin/env bash
# Lança a VM ARM da Oracle insistindo até a capacidade aparecer.
#
# A shape VM.Standard.A1.Flex do Always Free vive esgotada em São Paulo
# ("Out of capacity for shape VM.Standard.A1.Flex in availability domain AD-1").
# Não é erro de configuração: é fila. O console não serve para isso, então este
# script chama a API pela CLI num laço até um lançamento passar.
#
#   deploy/oracle-launch-retry.sh            # laço até conseguir
#   INTERVALO=120 deploy/oracle-launch-retry.sh
#
# Ao conseguir, grava o OCID em deploy/.oracle-instance e avisa no WhatsApp.
set -uo pipefail

export SUPPRESS_LABEL_WARNING=True

COMPARTIMENTO="ocid1.tenancy.oc1..aaaaaaaabeu6ijzpsldpqb3qlwanlzgbxd7zp6pwnfe5hcjoepphd3skcylq"
AD="lSaq:SA-SAOPAULO-1-AD-1"
SUBNET="ocid1.subnet.oc1.sa-saopaulo-1.aaaaaaaaryign66ohulvc5ivbgvxoccq2jha7vzh2mu67tewvxez7zmp74la"
IMAGEM="ocid1.image.oc1.sa-saopaulo-1.aaaaaaaav4hskmch2ikmva5wxqilujiwjsug7htb6k2silemwuzxcbwwxklq"
NOME="agenda-whatsapp"
OCPUS="${OCPUS:-1}"
MEMORIA="${MEMORIA:-6}"
INTERVALO="${INTERVALO:-90}"

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$RAIZ/deploy/oracle-launch-retry.log"
MARCADOR="$RAIZ/deploy/.oracle-instance"
CHAVE_PUB="$HOME/.ssh/id_ed25519.pub"

registrar() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" | tee -a "$LOG"; }

touch "$LOG"
registrar "iniciando laço: A1.Flex ${OCPUS} OCPU / ${MEMORIA} GB, intervalo ${INTERVALO}s"

# O relatório de capacidade é barato e responde na hora, então dá para vigiar
# de 30 em 30s e só chamar o launch quando a janela abre — bem mais provável de
# pegar a vaga do que tentar lançar de minuto em minuto às cegas.
SPEC="$(mktemp -t oci-capacidade)"
trap 'rm -f "$SPEC"' EXIT
cat > "$SPEC" <<JSON
[{"instanceShape":"VM.Standard.A1.Flex","instanceShapeConfig":{"ocpus":$OCPUS.0,"memoryInGBs":$MEMORIA.0}}]
JSON

tem_capacidade() {
  local status
  status="$(oci compute compute-capacity-report create \
    -c "$COMPARTIMENTO" --availability-domain "$AD" \
    --shape-availabilities "file://$SPEC" --no-retry \
    --query 'data."shape-availabilities"[0]."availability-status"' \
    --raw-output 2>/dev/null)"
  [ "$status" = "AVAILABLE" ]
}

tentativa=0
espera=0
while true; do
  if ! tem_capacidade; then
    espera=$((espera + 1))
    # Um registro a cada 20 sondagens (~10 min) para o log não virar ruído.
    [ $((espera % 20)) -eq 1 ] && registrar "sondagem $espera: sem capacidade"
    sleep 30
    continue
  fi

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
    registrar "SUCESSO na tentativa $tentativa: $ocid"
    printf '%s\n' "$ocid" > "$MARCADOR"

    ip="$(oci compute instance list-vnics --instance-id "$ocid" \
          --query 'data[0]."public-ip"' --raw-output 2>/dev/null)"
    registrar "IP público: $ip"
    printf '%s\n' "$ip" >> "$MARCADOR"

    "$RAIZ/bin/bot" msg "VM da Oracle subiu na tentativa $tentativa. IP: $ip" >/dev/null 2>&1 || true
    exit 0
  fi

  # A janela pode fechar entre a sondagem e o launch: outra conta pegou a vaga.
  if printf '%s' "$saida" | grep -qi 'out of capacity\|out of host capacity'; then
    registrar "tentativa $tentativa: a vaga fechou antes do launch, voltando a sondar"
    sleep 5
    continue
  elif printf '%s' "$saida" | grep -qi 'TooManyRequests\|429'; then
    registrar "tentativa $tentativa: rate limit, esperando 5 min"
    sleep 300
    continue
  else
    # Erro diferente (limite de serviço, permissão, config): parar e mostrar.
    registrar "tentativa $tentativa: erro inesperado, parando"
    printf '%s\n' "$saida" | tee -a "$LOG"
    exit 1
  fi

  sleep "$INTERVALO"
done
