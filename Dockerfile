# Open-Source Backend-Only Production Image
FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/backend/package.json ./packages/backend/

RUN npm ci || npm install

COPY packages/contracts ./packages/contracts
COPY packages/backend ./packages/backend
COPY scripts ./scripts
COPY tsconfig.json ./

RUN node scripts/ensure-native-modules.mjs node
RUN npm run build:server
RUN npm prune --production

FROM node:20-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    chromium \
    fonts-liberation \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3060
ENV HOST=0.0.0.0
ENV OPEN_EMPLOYEE_DATA_DIR=/app/.data
ENV CHROME_BIN=/usr/bin/chromium

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/.data
VOLUME ["/app/.data"]
EXPOSE 3060

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.mjs"]
