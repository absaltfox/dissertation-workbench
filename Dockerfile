FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV APP_DATA_DIR=/data
ENV SQLITE_PATH=/data/metrics.sqlite
ENV PDF_CACHE_DIR=/data/pdf-cache

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    poppler-utils \
    yaz \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY scripts ./scripts
COPY src ./src
COPY README.md ./

EXPOSE 3000

CMD ["npm", "start"]
