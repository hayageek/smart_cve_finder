#!/usr/bin/env node
/**
 * Runs `prisma migrate deploy` with the repo-root `.env`.
 * If the database was previously created via `db:push` (Prisma P3005),
 * marks migrations whose changes are already present, then deploys the rest.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const ENV_FILE = path.join(ROOT, '.env');
const SCHEMA = path.join(ROOT, 'apps/api/prisma/schema.prisma');
const MIGRATIONS_DIR = path.join(ROOT, 'apps/api/prisma/migrations');
const PRISMA = path.join(ROOT, 'node_modules/.bin/prisma');

function loadDatabaseUrl() {
  if (!existsSync(ENV_FILE)) {
    throw new Error(`Missing ${ENV_FILE}. Copy .env.example and set DATABASE_URL.`);
  }
  const env = readFileSync(ENV_FILE, 'utf8');
  const match = env.match(/^DATABASE_URL=(.+)$/m);
  if (!match) {
    throw new Error('DATABASE_URL is not set in .env');
  }
  return match[1].trim().replace(/^["']|["']$/g, '');
}

function runPrisma(args, { capture = false } = {}) {
  const result = spawnSync(process.execPath, [`--env-file=${ENV_FILE}`, PRISMA, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    const err = new Error(result.stderr?.trim() || `prisma exited with code ${result.status}`);
    err.stdout = result.stdout ?? '';
    err.stderr = result.stderr ?? '';
    throw err;
  }
  return result.stdout ?? '';
}

function sortedMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => existsSync(path.join(MIGRATIONS_DIR, name, 'migration.sql')))
    .sort();
}

function pendingSchemaSql(databaseUrl) {
  const out = runPrisma([
    'migrate', 'diff',
    '--from-url', databaseUrl,
    '--to-schema-datamodel', SCHEMA,
    '--script',
  ], { capture: true });
  const trimmed = out.trim();
  if (!trimmed || trimmed.includes('empty migration')) return '';
  return trimmed;
}

function migrationStillNeeded(migrationSql, pendingSql) {
  const normalize = (s) => s.replace(/\s+/g, ' ').trim().replace(/;$/, '');
  const pending = normalize(pendingSql);
  const statements = migrationSql
    .split(';')
    .map((chunk) => normalize(chunk))
    .filter((chunk) => chunk && !chunk.startsWith('--'));
  if (statements.length === 0) return false;
  return statements.some((statement) => pending.includes(statement));
}

function repoTableExists(databaseUrl) {
  const out = runPrisma([
    'migrate', 'diff',
    '--from-empty',
    '--to-url', databaseUrl,
    '--script',
  ], { capture: true });
  return out.includes('"Repo"');
}

function baselineExistingDatabase(databaseUrl) {
  const pending = pendingSchemaSql(databaseUrl);
  const migrations = sortedMigrations();

  if (!pending) {
    console.log('Database schema matches Prisma — recording migration history.');
    for (const name of migrations) {
      console.log(`  marking applied: ${name}`);
      runPrisma(['migrate', 'resolve', '--applied', name, '--schema', SCHEMA]);
    }
    return;
  }

  console.log('Baselining migrations already reflected in the database...');
  for (const name of migrations) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
    if (migrationStillNeeded(sql, pending)) {
      console.log(`  pending: ${name}`);
      continue;
    }
    console.log(`  marking applied: ${name}`);
    runPrisma(['migrate', 'resolve', '--applied', name, '--schema', SCHEMA]);
  }
}

function main() {
  if (!existsSync(ENV_FILE)) {
    console.error(`Error: ${ENV_FILE} not found. Copy .env.example and set DATABASE_URL.`);
    process.exit(1);
  }

  const databaseUrl = loadDatabaseUrl();

  try {
    console.log('Applying Prisma migrations...');
    runPrisma(['migrate', 'deploy', '--schema', SCHEMA]);
    console.log('Migrations complete.');
    return;
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
    if (!output.includes('P3005')) {
      console.error(output || err.message);
      process.exit(1);
    }
  }

  if (!repoTableExists(databaseUrl)) {
    console.error(
      'Error P3005: database is not empty but has no Prisma migration history.\n' +
      'Use an empty database for migrate deploy, or run npm run db:push for schema sync.',
    );
    process.exit(1);
  }

  console.log('Database was likely created with db:push — baselining migration history...');
  baselineExistingDatabase(databaseUrl);

  console.log('Applying pending migrations...');
  runPrisma(['migrate', 'deploy', '--schema', SCHEMA]);
  console.log('Migrations complete.');
}

main();
