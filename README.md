# SecScan — Security Repository Scanner

A full-stack platform that clones public Git repositories, runs CVE pattern hunting and exploit generation using Cursor Agent skills, and presents results in a live React UI.

## Architecture

```
apps/api      – Express + Prisma + Socket.io REST API
apps/workers  – BullMQ workers (scanner + exploit-generator)
apps/ui       – React + Vite + TanStack frontend
packages/shared – Shared TypeScript types and constants
```

**Infrastructure:** PostgreSQL, Redis, BullMQ, Socket.io

## Quick Start

### 1. Configure environment

```bash
cp .env.example .env
# Edit .env — set POSTGRES_PASSWORD, and CURSOR_AGENT_BIN path
```

### 2. Start with Docker Compose

```bash
docker-compose up --build
```

| Service | URL |
|---------|-----|
| UI | http://localhost:3000 |
| API | http://localhost:4000 |
| API Health | http://localhost:4000/health |

Scale the workers service when you need more parallel scans. The `workers` service publishes no host ports, so Compose can run multiple copies against the same Redis queues. Total parallel scans are `replicas × SCANNER_CONCURRENCY` (exploits: `replicas × EXPLOIT_CONCURRENCY`).

```bash
docker compose up -d --scale workers=3
```

### 3. cursor-agent requirement

The `workers` container needs the `cursor-agent` CLI binary available.
Set `CURSOR_AGENT_BIN` in `.env` to the absolute path of your `cursor-agent` binary on the host.
Docker Compose bind-mounts it into the container at `/usr/local/bin/cursor-agent`.

```env
CURSOR_AGENT_BIN=/path/to/your/cursor-agent
```

## Development (without Docker)

```bash
# Start PostgreSQL and Redis (or use docker-compose for just infra)
docker-compose up db redis -d

# Install all deps
npm install

# Build shared types
npm run build --workspace=packages/shared

# Generate Prisma client + apply schema (uses project Prisma 5, not global npx)
npm run db:push

# Run API, workers, and UI in separate terminals
npm run dev:api      # http://localhost:4000
npm run dev:workers
npm run dev:ui       # http://localhost:3000
```

## Worker logs

Workers write the same lines to stdout, to `workers.log`, and to the live stream on the Workers page.

**UI.** Open http://localhost:3000/workers. The page tails the log file and streams new lines. The download button saves the full file.

**Docker Compose.**

```bash
docker compose logs -f workers
```

With several replicas, that follows every `workers` container. To follow one of them:

```bash
docker compose logs -f workers-1
```

**On disk.** Compose mounts the log directory at `./volumes/logs/workers.log`:

```bash
tail -f volumes/logs/workers.log
```

When workers run via `npm run dev:workers`, the file is `./data/logs/workers.log` (or whatever `LOGS_DIR` resolves to). The API also serves the tail:

```bash
curl 'http://localhost:4000/api/workers/logs?tail=500'
```

## UI Navigation

| Section | Description |
|---------|-------------|
| Dashboard | Live stats, queue depths, activity feed |
| Repositories → Import | Upload CSV of repo URLs |
| Repositories → All Repos | Search, re-scan, delete |
| Scans → Queue | Live job cards with pipeline stages |
| Scans → History | Completed scans with detail drawer |
| Vulnerabilities → Confirmed | CVE findings with CVSS, exploit download |
| Vulnerabilities → Dropped | Suppressed findings, promote to confirmed |
| Exploits | Download report.md, exploit.py, payload.py |
| Workers | Start/Pause/Drain, concurrency sliders, live logs |
| Settings | Scanner config, notifications, data management |

## CSV Format

One URL per line (or comma-separated):

```
https://github.com/org/repo1
https://github.com/org/repo2
https://bitbucket.org/org/repo3
```

## Environment Variables

See [`.env.example`](.env.example) for all configuration options with inline documentation.

Key variables:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_HOST` / `REDIS_PORT` | Redis connection |
| `CURSOR_AGENT_BIN` | Path to cursor-agent binary |
| `AGENT_RUNNER` | `cursor` or `claude` (default: cursor). Settings → Scanner overrides this |
| `CLAUDE_AGENT_MODEL` | Model id for the Claude Agent SDK runner (default: `openai/glm-5.2`) |
| `CLAUDE_AGENT_MAX_TURNS` | Max agent turns per skill run (default: 50) |
| `CLAUDE_MAX_TOKENS` | Legacy; not used by the agent-sdk runner |
| `ANTHROPIC_BASE_URL` | Optional Anthropic-compatible proxy URL for the Claude runner |
| `ANTHROPIC_API_KEY` | Optional Claude API key. Omitted when empty |
| `SCANNER_CONCURRENCY` | Parallel clone+scan workers (default: 3) |
| `EXPLOIT_CONCURRENCY` | Parallel exploit-gen workers (default: 2) |
| `EXPLOIT_MIN_SEVERITY` | Min severity to generate exploits (default: HIGH) |
| `SCAN_DEDUP_WINDOW_HOURS` | Skip re-scan within N hours (0 = always scan) |

## Persistent Data

All data survives container restarts via volume mounts:

| Mount | Purpose |
|-------|---------|
| `./volumes/postgres` | Database |
| `./volumes/redis` | Queue state |
| `./volumes/workspaces` | Cloned repos (auto-cleaned after TTL) |
| `./volumes/atlassian_reports` | Exploit artifacts |
| `./volumes/logs` | Worker logs |
