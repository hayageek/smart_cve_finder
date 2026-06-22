FROM node:24-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssl ripgrep \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/cve-semgrep/package.json ./packages/cve-semgrep/
COPY packages/secret-scan/package.json ./packages/secret-scan/
COPY packages/source-revision/package.json ./packages/source-revision/
COPY apps/workers/package.json ./apps/workers/
RUN npm ci --workspaces --if-present

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
# Use glibc (node:24-slim) — @cursor/sdk ships native linux binaries (cursorsandbox)
# that fail on Alpine/musl. Semgrep installs via pip venv on Debian as well.
FROM node:24-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssl ca-certificates curl unzip tar ripgrep python3 python3-pip python3-venv \
    && python3 -m venv /opt/semgrep \
    && /opt/semgrep/bin/pip install --no-cache-dir semgrep \
    && rm -rf /var/lib/apt/lists/* /root/.cache/pip

# Gitleaks + TruffleHog for secret scanning
ARG GITLEAKS_VERSION=8.22.1
ARG TRUFFLEHOG_VERSION=3.88.3
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) GL_ARCH=linux_x64; TH_ARCH=linux_amd64 ;; \
      arm64) GL_ARCH=linux_arm64; TH_ARCH=linux_arm64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}"; exit 1 ;; \
    esac \
    && curl -sSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${GL_ARCH}.tar.gz" \
      | tar xz -C /usr/local/bin gitleaks \
    && curl -sSL "https://github.com/trufflesecurity/trufflehog/releases/download/v${TRUFFLEHOG_VERSION}/trufflehog_${TRUFFLEHOG_VERSION}_${TH_ARCH}.tar.gz" \
      | tar xz -C /usr/local/bin trufflehog \
    && gitleaks version \
    && trufflehog --version
ENV PATH="/opt/semgrep/bin:${PATH}"

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages ./packages
COPY --from=base /app/apps/workers ./apps/workers
COPY --from=base /app/apps/api/prisma ./apps/api/prisma

ENV NODE_ENV=production
CMD ["node", "apps/workers/dist/index.js"]
