# Imagem do bot para servidor Linux ARM64 (Oracle Cloud Ampere).
#
# Duas decisões que valem explicação:
#  1. Chromium vem do apt do Debian, não do Puppeteer: não existe build do
#     Chrome for Testing para linux/arm64. Por isso PUPPETEER_SKIP_DOWNLOAD.
#  2. O whisper.cpp é compilado num estágio separado e só o binário viaja para
#     a imagem final, que fica sem compilador.

# ─── estágio 1: whisper.cpp + modelo de transcrição ──────────────────────────
FROM node:22-bookworm-slim AS whisper

ARG WHISPER_MODELO=small
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

# GGML_NATIVE=OFF é obrigatório aqui por dois motivos: com a detecção nativa o
# GCC do bookworm quebra em ARM ("inlining failed ... vfmaq_f16: target specific
# option mismatch"), e o binário sairia com as flags da CPU que fez o build, que
# não são necessariamente as do servidor. armv8.2-a+fp16 é o baseline do Ampere
# Altra (Neoverse-N1) que a Oracle usa.
RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp /tmp/whisper \
    && cmake -S /tmp/whisper -B /tmp/whisper/build \
       -DCMAKE_BUILD_TYPE=Release \
       -DWHISPER_BUILD_TESTS=OFF \
       -DWHISPER_BUILD_EXAMPLES=ON \
       -DGGML_NATIVE=OFF \
       -DGGML_CPU_ARM_ARCH=armv8.2-a+fp16 \
       -DBUILD_SHARED_LIBS=OFF \
    && cmake --build /tmp/whisper/build --config Release -j "$(nproc)" \
    && mkdir -p /opt/whisper-models \
    && cp /tmp/whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli \
    && wget -q -O "/opt/whisper-models/ggml-${WHISPER_MODELO}.bin" \
       "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODELO}.bin"

# ─── estágio 2: imagem final ─────────────────────────────────────────────────
FROM node:22-bookworm-slim

ARG WHISPER_MODELO=small

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation fonts-noto-color-emoji \
      ffmpeg \
      ca-certificates \
      openssh-client \
      tini \
      python3 \
      procps \
      # o whatsapp-web.js é instalado direto do GitHub (ver package.json)
      git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=whisper /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /opt/whisper-models /opt/whisper-models

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    WHISPER_BIN=/usr/local/bin/whisper-cli \
    WHISPER_MODELO=/opt/whisper-models/ggml-${WHISPER_MODELO}.bin \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    NODE_ENV=production \
    TZ=America/Sao_Paulo

WORKDIR /app

# Dependências primeiro: a camada só reconstrói quando o package.json muda.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

# Chromium com --no-sandbox como root é uma combinação ruim; roda como 'node'.
RUN chown -R node:node /app
USER node

# tini colhe os processos zumbis que o Chromium deixa a cada reinício de sessão.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
