#!/usr/bin/env node
/**
 * top-packages — fetch top N packages per ecosystem with GitHub/repo links.
 *
 * Uses LIBRARIES_IO_KEY from top_packages/.env (libraries.io, ranked by dependents).
 * PyPI, Packagist, and Cargo can use native download-based lists with --source native.
 *
 * Usage:
 *   npm run top-packages -- -n 100 --all
 *   npm run top-packages -- -n 50 --ecosystems npm,pypi -o top.csv
 *   npm run top-packages -- --all --urls-only -o github-urls.txt
 *   npm run top-packages -- --ecosystems rust --source native
 *   npm run top-packages -- --recent -o recent.csv
 *   npm run top-packages -- --recent --since-hours 1 -o recent-1h.csv
 */

import { writeFile } from 'fs/promises';
import { librariesIoDelayMs, librariesIoKey } from './config.js';
import { setLibrariesIoMinInterval, librariesIoMinInterval } from './libraries-io-client.js';
import { toCsv, toJson } from './output.js';
import { fetchRecentPackages, fetchTopPackages, resolveSourceMode } from './sources/index.js';
import {
  ALL_ECOSYSTEMS,
  RECENT_DEFAULT_ECOSYSTEMS,
  type EcosystemId,
  type SourceMode,
} from './types.js';

const ECOSYSTEM_ALIASES: Record<string, EcosystemId> = {
  npm: 'npm',
  pypi: 'pypi',
  pip: 'pypi',
  python: 'pypi',
  maven: 'maven',
  java: 'maven',
  go: 'go',
  golang: 'go',
  php: 'php',
  packagist: 'php',
  ruby: 'ruby',
  gem: 'ruby',
  rubygems: 'ruby',
  rust: 'rust',
  cargo: 'rust',
  crates: 'rust',
};

function usage(): string {
  return `top-packages — fetch top N packages with repository links

Usage:
  top-packages [options]

Options:
  -n, --limit <N>           Packages per ecosystem (default: 100; with --recent: no cap)
  --ecosystems <list>       Comma-separated: npm,pypi,maven,go,php,ruby,rust
  --all                     All ecosystems (default for top lists; with --recent use --all for every ecosystem)
  --recent                  Packages published within --since-hours (libraries.io)
  --since-hours <N>         Window for --recent (default: 5)
  -o, --output <path>       Write to file (default: stdout)
  --format <csv|json>       Output format (default: csv)
  --source <auto|libraries-io|native>
                            Data source (default: auto; ignored with --recent)
  --urls-only               CSV/txt: one repo URL per line (skips rows without repo)
  --libraries-io-delay-ms   Min ms between libraries.io calls (default: 1350, ~44/min)
  -v, --verbose             Extra debug logging (--recent always logs progress to stderr)
  -h, --help                Show this help

Environment:
  LIBRARIES_IO_KEY          Set in top_packages/.env (required for --recent on npm/go)
  LIBRARIES_IO_DELAY_MS     Override min interval between libraries.io requests
  ENRICH_CONCURRENCY        Parallel PyPI/Packagist/crates.io metadata calls (default: 3)

Note: --source auto uses native download lists for pypi/php/rust (no libraries.io
quota) and libraries.io only for npm/maven/go/ruby (~4 requests for --all -n 100).
--recent defaults to npm,pypi,go,php,rust. npm/go use libraries.io (rate-limited,
often dozens of pages for npm). pypi/php/rust use native RSS/API (fast).

Examples:
  npm run top-packages -- -n 100 --all -o top-100.csv
  npm run top-packages -- -n 25 --ecosystems npm,pypi --urls-only -o repos.txt
  npm run top-packages -- --recent -o recent-5h.csv
  npm run top-packages -- --recent --since-hours 24 -o recent-24h.csv
  npm run top-packages -- --recent -n 100 --ecosystems npm,rust -o recent.csv
`;
}

const argv = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return argv.includes(name);
}

if (hasFlag('-h') || hasFlag('--help')) {
  console.log(usage());
  process.exit(0);
}

const recent = hasFlag('--recent');
const limitFlag = getFlag('-n') ?? getFlag('--limit');
const limit = limitFlag ? Math.max(1, Number(limitFlag)) : recent ? null : 100;
const sinceHours = Math.max(
  1,
  Number(getFlag('--since-hours') ?? '5'),
);
const outputPath = getFlag('-o') ?? getFlag('--output');
const format = (getFlag('--format') ?? 'csv').toLowerCase();
const source = (getFlag('--source') ?? 'auto') as SourceMode;
const urlsOnly = hasFlag('--urls-only');
const verbose = hasFlag('-v') || hasFlag('--verbose');
const ecosystemsFlag = getFlag('--ecosystems');
const delayFlag = getFlag('--libraries-io-delay-ms');
if (delayFlag) {
  const ms = Number(delayFlag);
  if (!Number.isFinite(ms) || ms < 500) {
    console.error('--libraries-io-delay-ms must be a number >= 500');
    process.exit(1);
  }
  setLibrariesIoMinInterval(ms);
} else {
  setLibrariesIoMinInterval(librariesIoDelayMs());
}

function log(...args: unknown[]) {
  if (verbose) console.error('[top-packages]', ...args);
}

function progress(...args: unknown[]) {
  console.error('[top-packages]', ...args);
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function parseEcosystems(raw: string): EcosystemId[] {
  const ids: EcosystemId[] = [];
  const seen = new Set<EcosystemId>();
  for (const part of raw.split(',')) {
    const key = part.trim().toLowerCase();
    if (!key) continue;
    const id = ECOSYSTEM_ALIASES[key];
    if (!id) throw new Error(`Unknown ecosystem "${part.trim()}"`);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) throw new Error('No ecosystems specified');
  return ids;
}

const ecosystems: EcosystemId[] = ecosystemsFlag
  ? parseEcosystems(ecosystemsFlag)
  : hasFlag('--all')
    ? [...ALL_ECOSYSTEMS]
    : recent
      ? [...RECENT_DEFAULT_ECOSYSTEMS]
      : [...ALL_ECOSYSTEMS];

if (recent && Number.isNaN(sinceHours)) {
  console.error('--since-hours must be a positive number');
  process.exit(1);
}

if (limit !== null && Number.isNaN(limit)) {
  console.error('-n/--limit must be a positive number');
  process.exit(1);
}

if (!['csv', 'json'].includes(format)) {
  console.error(`Invalid --format "${format}" (use csv or json)`);
  process.exit(1);
}

if (!['auto', 'libraries-io', 'native'].includes(source)) {
  console.error(`Invalid --source "${source}"`);
  process.exit(1);
}

function estimateLibrariesIoRequests(ecosystems: EcosystemId[], limit: number, mode: SourceMode): number {
  let pages = 0;
  for (const eco of ecosystems) {
    if (resolveSourceMode(eco, mode) !== 'libraries-io') continue;
    pages += Math.ceil(limit / 30);
  }
  return pages;
}

async function main(): Promise<void> {
  const runStartedAt = Date.now();

  if (recent) {
    progress(`Recent scan: last ${sinceHours}h · ecosystems ${ecosystems.join(', ')}`);
    if (librariesIoKey()) {
      progress(
        `libraries.io key loaded · npm/go paginated at ~${librariesIoMinInterval()}ms/request (npm can need many pages even for 1h)`,
      );
    } else {
      progress('No LIBRARIES_IO_KEY — npm/go skipped; pypi/php/rust use native feeds');
    }
    progress('pypi/php/rust use native RSS/API (single request each)');
    log('Verbose mode on');
  } else if (librariesIoKey()) {
    log('Using LIBRARIES_IO_KEY from top_packages/.env');
    const liRequests = estimateLibrariesIoRequests(ecosystems, limit ?? 100, source);
    const estSec = Math.ceil((liRequests * librariesIoMinInterval()) / 1000);
    log(
      `libraries.io: ~${liRequests} request(s), min ${librariesIoMinInterval()}ms apart (~${estSec}s if all used)`,
    );
  } else {
    log('No LIBRARIES_IO_KEY — native sources only for pypi, php, rust');
  }

  const allRows: Awaited<ReturnType<typeof fetchTopPackages>> = [];

  for (const ecosystem of ecosystems) {
    if (recent) {
      const cap = limit === null ? 'all' : String(limit);
      const ecoStartedAt = Date.now();
      const source =
        ecosystem === 'pypi' || ecosystem === 'php' || ecosystem === 'rust'
          ? 'native'
          : 'libraries.io';
      progress(`[${ecosystem}] starting (${sinceHours}h window, max ${cap}, ${source})…`);
      try {
        const rows = await fetchRecentPackages(
          ecosystem,
          sinceHours,
          limit,
          (msg) => progress(`[${ecosystem}] ${msg}`),
        );
        allRows.push(...rows);
        const withRepo = rows.filter((r) => r.repoUrl).length;
        progress(
          `[${ecosystem}] done — ${rows.length} packages (${withRepo} with repo) in ${formatElapsed(Date.now() - ecoStartedAt)}`,
        );
      } catch (err) {
        console.error(`[top-packages] ${ecosystem}: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
      continue;
    }

    const resolved = resolveSourceMode(ecosystem, source);
    log(`Fetching top ${limit} for ${ecosystem} (${resolved})...`);
    try {
      const rows = await fetchTopPackages(
        ecosystem,
        limit!,
        source,
        verbose ? (msg) => log(`  ${msg}`) : undefined,
      );
      allRows.push(...rows);
      const withRepo = rows.filter((r) => r.repoUrl).length;
      log(`  ${rows.length} packages, ${withRepo} with repo URL`);
    } catch (err) {
      console.error(`[top-packages] ${ecosystem}: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  }

  if (allRows.length === 0) {
    console.error('[top-packages] No packages fetched');
    process.exit(1);
  }

  const body = format === 'json' ? toJson(allRows) : toCsv(allRows, urlsOnly);

  if (recent) {
    progress(
      `Finished — ${allRows.length} total rows in ${formatElapsed(Date.now() - runStartedAt)}`,
    );
  }

  if (outputPath) {
    await writeFile(outputPath, body, 'utf8');
    if (recent) progress(`Wrote ${allRows.length} rows to ${outputPath}`);
    else log(`Wrote ${allRows.length} rows to ${outputPath}`);
  } else {
    process.stdout.write(body);
  }
}

main().catch((err) => {
  console.error('[top-packages]', err instanceof Error ? err.message : err);
  process.exit(1);
});
