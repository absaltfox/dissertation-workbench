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
  && mkdir -p /data \
  && chown -R node:node /data \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src
COPY --chown=node:node README.md ./

EXPOSE 3000

USER node

CMD ["npm", "start"]
