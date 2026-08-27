FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# agy is a standalone binary; this is its documented Linux installer.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
    && /root/.local/bin/agy --version

ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY bin ./bin
COPY extensions ./extensions
COPY server.ts ./
RUN chmod +x ./bin/web-access-kit-server

ENV HOST=0.0.0.0 \
    PORT=3000 \
    PREFIX=/web-access-kit
EXPOSE 3000

CMD ["node", "bin/web-access-kit-server"]
