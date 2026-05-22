FROM node:24-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/workers/package.json ./apps/workers/
RUN npm install --workspaces --if-present

COPY packages/shared ./packages/shared
RUN npm run build --workspace=packages/shared

COPY apps/api/prisma ./apps/api/prisma
COPY apps/workers ./apps/workers
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma
RUN npm run build --workspace=apps/workers

# ── Runtime image ────────────────────────────────────────────────
FROM node:24-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssl ca-certificates unzip tar \
    && rm -rf /var/lib/apt/lists/*

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages ./packages
COPY --from=base /app/apps/workers ./apps/workers
COPY --from=base /app/apps/api/prisma ./apps/api/prisma

ENV NODE_ENV=production
CMD ["node", "apps/workers/dist/index.js"]
