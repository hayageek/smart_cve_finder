#!/usr/bin/env bash
# ── SecScan Docker Compose cheatsheet ────────────────────────────

# Restart backend + workers (existing image, fast)
docker compose restart api workers

# Restart DB + Redis
docker compose restart db redis

# Restart everything
docker compose restart

# Rebuild + restart after code changes
docker compose up -d --build api workers
docker compose up -d --build          # all services

# Stop services
docker compose stop api workers
docker compose stop                   # all

# Start all services (first time or after stop)
docker compose up -d

# Bring everything down (keeps volumes/data)
docker compose down

# Bring down AND wipe volumes (WARNING: deletes all DB data)
docker compose down -v

# ── Logs ─────────────────────────────────────────────────────────
docker compose logs api --tail=50 -f
docker compose logs workers --tail=50 -f
docker compose logs api workers --tail=30 -f
docker compose logs db --tail=30
docker compose logs redis --tail=20

# ── Status ───────────────────────────────────────────────────────
docker compose ps