#!/usr/bin/env bash
# Create the Postgres role/database (from .env) and apply the Prisma schema.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example to .env and set POSTGRES_* / DATABASE_URL." >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source .env
set +a

POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-secscan}"
POSTGRES_USER="${POSTGRES_USER:-secscan}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-changeme}"
# Superuser connection for CREATE ROLE / CREATE DATABASE (defaults to your OS user via peer auth)
POSTGRES_ADMIN_DB="${POSTGRES_ADMIN_DB:-postgres}"
POSTGRES_ADMIN_USER="${POSTGRES_ADMIN_USER:-}"

psql_admin() {
  local args=(-h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -d "$POSTGRES_ADMIN_DB" -v ON_ERROR_STOP=1)
  if [[ -n "$POSTGRES_ADMIN_USER" ]]; then
    args+=(-U "$POSTGRES_ADMIN_USER")
  fi
  psql "${args[@]}" "$@"
}

echo "→ Checking Postgres at ${POSTGRES_HOST}:${POSTGRES_PORT} ..."
psql_admin -c 'SELECT 1' >/dev/null

echo "→ Ensuring role ${POSTGRES_USER} ..."
psql_admin <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${POSTGRES_USER}') THEN
    CREATE ROLE ${POSTGRES_USER} LOGIN PASSWORD '${POSTGRES_PASSWORD//\'/\'\'}';
  ELSE
    ALTER ROLE ${POSTGRES_USER} WITH PASSWORD '${POSTGRES_PASSWORD//\'/\'\'}';
  END IF;
END
\$\$;
SQL

echo "→ Ensuring database ${POSTGRES_DB} ..."
if ! psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '${POSTGRES_DB}'" | grep -q 1; then
  psql_admin -c "CREATE DATABASE ${POSTGRES_DB} OWNER ${POSTGRES_USER};"
else
  psql_admin -c "ALTER DATABASE ${POSTGRES_DB} OWNER TO ${POSTGRES_USER};" 2>/dev/null || true
fi

psql_admin -c "GRANT ALL PRIVILEGES ON DATABASE ${POSTGRES_DB} TO ${POSTGRES_USER};"

if [[ ! -d node_modules ]]; then
  echo "→ Installing npm dependencies ..."
  npm install
fi

echo "→ Applying Prisma schema (db push) ..."
node --env-file=.env ./node_modules/.bin/prisma db push --schema=apps/api/prisma/schema.prisma

echo "✓ Database ready: ${POSTGRES_USER}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
