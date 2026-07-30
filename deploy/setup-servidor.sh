#!/usr/bin/env bash
# Prepara uma VM Ubuntu ARM recém-criada (Oracle Cloud Ampere) para rodar o bot.
# Rodar NA VM, uma vez:
#   bash deploy/setup-servidor.sh
set -euo pipefail

echo "==> Atualizando o sistema"
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

echo "==> Instalando Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "    (você precisa sair e entrar de novo no SSH para usar docker sem sudo)"
fi

echo "==> Fuso horário"
sudo timedatectl set-timezone America/Sao_Paulo

echo "==> Swap de 2 GB"
# O build do Chromium e os picos do whisper agradecem; a VM da Oracle vem sem swap.
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> Firewall"
# A Oracle vem com iptables travado e regras persistidas; o bot não expõe porta
# nenhuma (só faz conexões de saída), então não há o que liberar além do SSH.
sudo iptables -L INPUT -n --line-numbers | head -20 || true

echo "==> Tailscale (rede privada com o Mac, para os comandos 'claude:' e 'ideia:')"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
  echo "    rode: sudo tailscale up   (e autorize no navegador)"
fi

echo
echo "Pronto. Próximos passos:"
echo "  1. sair e entrar de novo no SSH (para o grupo docker valer)"
echo "  2. sudo tailscale up"
echo "  3. copiar o projeto: rode deploy/sync.sh no Mac"
echo "  4. criar o .env no servidor (veja deploy/env.example)"
echo "  5. docker compose -f deploy/docker-compose.yml up -d --build"
