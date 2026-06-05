FROM node:24-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssl ripgrep \
    && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/cve-semgrep/package.json ./packages/cve-semgrep/
COPY packages/secret-scan/package.json ./packages/secret-scan/
COPY packages/source-revision/package.json ./packages/source-revision/
COPY apps/workers/package.json ./apps/workers/
RUN npm install --workspaces --if-present

COPY packages/shared ./packages/shared
COPY packages/cve-semgrep ./packages/cve-semgrep
COPY packages/secret-scan ./packages/secret-scan
COPY packages/source-revision ./packages/source-revision
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/cve-semgrep
RUN npm run build --workspace=packages/secret-scan
RUN npm run build --workspace=packages/source-revision

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

# Gitleaks + TruffleHog for secret scanning
ARG GITLEAKS_VERSION=8.22.1
ARG TRUFFLEHOG_VERSION=3.88.3
RUN apk add --no-cache curl \
    && curl -sSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
      | tar xz -C /usr/local/bin gitleaks \
    && curl -sSL "https://github.com/trufflesecurity/trufflehog/releases/download/v${TRUFFLEHOG_VERSION}/trufflehog_${TRUFFLEHOG_VERSION}_linux_amd64.tar.gz" \
      | tar xz -C /usr/local/bin trufflehog \
    && apk del curl \
    && gitleaks version \
    && trufflehog --version
ENV PATH="/opt/semgrep/bin:${PATH}"

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages ./packages
COPY --from=base /app/apps/workers ./apps/workers
COPY --from=base /app/apps/api/prisma ./apps/api/prisma

ENV NODE_ENV=production
CMD ["node", "apps/workers/dist/index.js"]
