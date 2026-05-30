FROM node:24-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssl ripgrep \
    && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/cve-semgrep/package.json ./packages/cve-semgrep/
COPY apps/workers/package.json ./apps/workers/
RUN npm install --workspaces --if-present

COPY packages/shared ./packages/shared
COPY packages/cve-semgrep ./packages/cve-semgrep
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/cve-semgrep

COPY apps/api/prisma ./apps/api/prisma
COPY apps/workers ./apps/workers
RUN npm exec -- prisma generate --schema=apps/api/prisma/schema.prisma
RUN npm run build --workspace=apps/workers

# ── Runtime image ────────────────────────────────────────────────
# Alpine (musl) — semgrep's manylinux/glibc wheels SIGILL on arm64 Docker
# (Apple Silicon); musllinux wheels from pip work reliably here.
FROM node:24-alpine AS runner
WORKDIR /app

RUN apk add --no-cache \
    git openssl ca-certificates unzip tar ripgrep python3 py3-pip \
    && python3 -m venv /opt/semgrep \
    && /opt/semgrep/bin/pip install --no-cache-dir semgrep \
    && rm -rf /root/.cache/pip
ENV PATH="/opt/semgrep/bin:${PATH}"

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages ./packages
COPY --from=base /app/apps/workers ./apps/workers
COPY --from=base /app/apps/api/prisma ./apps/api/prisma

ENV NODE_ENV=production
CMD ["node", "apps/workers/dist/index.js"]
