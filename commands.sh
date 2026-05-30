#!/usr/bin/env bash
# ── SecScan Docker Compose cheatsheet ────────────────────────────

# Restart backend + workers (existing image, fast)
docker compose restart api workers

# Restart everything
docker compose restart

# Rebuild + restart after code changes
docker compose up -d --build --remove-orphans api workers
docker compose up -d --build --remove-orphans          # all services

# Stop services
docker compose stop api workers
docker compose stop                   # all

# Start all services (first time or after stop)
docker compose up -d --remove-orphans

# Bring everything down; --remove-orphans drops old db/redis containers too
docker compose down --remove-orphans

# ── Logs ─────────────────────────────────────────────────────────
docker compose logs api --tail=50 -f
docker compose logs workers --tail=50 -f
docker compose logs api workers --tail=30 -f
docker compose logs ui --tail=30

# ── Status ───────────────────────────────────────────────────────
docker compose ps
