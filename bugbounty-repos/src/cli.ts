#!/usr/bin/env node
/**
 * bugbounty-repos — active GitHub repos for bug bounty program organizations.
 *
 * Edit programs.yml, then run:
 *   npm run bugbounty-repos -- -o ../bugbounty-active-repos.csv
 *   npm run bugbounty-repos -- --force
 *   npm run bugbounty-repos -- --force-org google --force-org microsoft
 */

import { resolve } from 'path';
import { defaultOptions, run } from './run.js';
import type { CliOptions } from './types.js';
import { packageRoot, resolveCliPath } from './config.js';

function usage(): string {
  return `bugbounty-repos — fetch active GitHub repos for bug bounty programs

Usage:
  bugbounty-repos [options]

Options:
  --programs <path>     Programs YAML (default: bugbounty-repos/programs.yml)
  -o, --output <path>   CSV output path (default: ./bugbounty-active-repos.csv)
  --cache-dir <path>    Per-org JSON cache directory (default: bugbounty-repos/.cache/orgs)
  --days <n>            Active window in days (default: 365)
  --force               Clear all org cache and refetch every org
  --force-org <org>     Clear cache for one org (repeatable); refetch that org
  -v, --verbose         Reserved for extra logging
  -h, --help            Show this help

Environment:
  GITHUB_TOKEN / GH_TOKEN   Optional; loaded from repo .env if set

Cache:
  Each org is cached as <cache-dir>/<org>.json. Re-runs skip API calls for
  cached orgs unless --force, --force-org, or --days changes the cutoff.

Examples:
  npm run bugbounty-repos -- -o bugbounty-active-repos.csv
  npm run bugbounty-repos -- --programs ./my-programs.yml
  npm run bugbounty-repos -- --force-org Shopify
  npm run bugbounty-repos -- --force --days 180
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

function parseArgs(): CliOptions | 'help' {
  if (hasFlag('-h') || hasFlag('--help')) return 'help';

  const root = packageRoot();
  const options = defaultOptions();

  const programs = getFlag('--programs');
  if (programs) options.programsPath = resolveCliPath(programs);

  const output = getFlag('-o') ?? getFlag('--output');
  if (output) options.outputPath = resolveCliPath(output);

  const cacheDir = getFlag('--cache-dir');
  if (cacheDir) options.cacheDir = resolveCliPath(cacheDir);

  const days = getFlag('--days');
  if (days) {
    const n = Number(days);
    if (!Number.isFinite(n) || n < 1) throw new Error('--days must be a positive number');
    options.days = Math.floor(n);
  }

  options.force = hasFlag('--force');
  options.verbose = hasFlag('-v') || hasFlag('--verbose');

  const forceOrgs = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force-org' && argv[i + 1]) {
      forceOrgs.add(argv[i + 1]);
    }
  }
  options.forceOrgs = forceOrgs;

  // Normalize defaults relative to package when not overridden
  if (!programs) options.programsPath = resolve(root, 'programs.yml');
  if (!output) options.outputPath = resolve(root, '..', 'bugbounty-active-repos.csv');
  if (!cacheDir) options.cacheDir = resolve(root, '.cache', 'orgs');

  return options;
}

async function main(): Promise<number> {
  try {
    const parsed = parseArgs();
    if (parsed === 'help') {
      console.log(usage());
      return 0;
    }

    await run(parsed);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    return 1;
  }
}

main().then((code) => process.exit(code));
