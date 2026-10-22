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
    git openssl ca-certificates curl unzip tar ripgrep jq \
    python3 python3-pip python3-venv \
    build-essential pkg-config libssl-dev \
    && python3 -c "import tomllib" \
    && python3 -m pip install --no-cache-dir --break-system-packages tomli \
    && python3 -m venv /opt/semgrep \
    && /opt/semgrep/bin/pip install --no-cache-dir semgrep pip-audit \
    && ln -sf /opt/semgrep/bin/pip-audit /usr/local/bin/pip-audit \
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

# sbom-vuln-mapper + cve-variant-hunter toolchain.
# npm ships with the Node image. tomllib is the Python 3.11+ stdlib (tomli is the fallback).
# jq filters osv-scanner output. gh enriches advisories. cargo-audit is the `cargo audit` subcommand.
ARG GH_VERSION=2.103.0
ARG OSV_SCANNER_VERSION=2.7.0
ARG GO_VERSION=1.27.3
ARG GOVULNCHECK_VERSION=v1.9.0
RUN case "${TARGETARCH}" in \
      amd64) GH_ARCH=amd64; OSV_ARCH=amd64; GO_ARCH=amd64 ;; \
      arm64) GH_ARCH=arm64; OSV_ARCH=arm64; GO_ARCH=arm64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}"; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz" \
      | tar xz -C /tmp \
    && mv /tmp/gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh /usr/local/bin/gh \
    && rm -rf /tmp/gh_${GH_VERSION}_linux_${GH_ARCH} \
    && curl -fsSL -o /usr/local/bin/osv-scanner \
      "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_${OSV_ARCH}" \
    && chmod +x /usr/local/bin/osv-scanner \
    && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" \
      | tar xz -C /usr/local \
    && GOBIN=/usr/local/bin /usr/local/go/bin/go install golang.org/x/vuln/cmd/govulncheck@${GOVULNCHECK_VERSION} \
    && rm -rf /root/go/pkg /root/.cache/go-build \
    && curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable \
    && . /root/.cargo/env \
    && cargo install cargo-audit --locked \
    && gh --version \
    && osv-scanner --version \
    && npm --version \
    && pip-audit --version \
    && cargo --version \
    && cargo audit --version \
    && govulncheck -version \
    && python3 -c "import tomllib, tomli; print('tomllib', tomllib.__name__)" \
    && jq --version

ENV PATH="/usr/local/go/bin:/root/.cargo/bin:/opt/semgrep/bin:${PATH}"
ENV GOPATH=/root/go
ENV CARGO_HOME=/root/.cargo
ENV RUSTUP_HOME=/root/.rustup

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages ./packages
COPY --from=base /app/apps/workers ./apps/workers
COPY --from=base /app/apps/api/prisma ./apps/api/prisma

ENV NODE_ENV=production
CMD ["node", "apps/workers/dist/index.js"]
