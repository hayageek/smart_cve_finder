#!/usr/bin/env node
/**
 * secret-scan CLI — test Gitleaks + TruffleHog on a local directory (no Cursor).
 *
 * Usage:
 *   secret-scan <directory> [options]
 *   npm run cli --workspace=packages/secret-scan -- /path/to/repo
 *
 * Options:
 *   --json                 Print full gate result as JSON
 *   --gitleaks-bin <path>  Gitleaks binary (default: gitleaks)
 *   --trufflehog-bin <path> TruffleHog binary (default: trufflehog)
 *   --config <path>        Gitleaks config (default: bundled gitleaks.toml)
 *   --no-git               Filesystem only (no git history)
 *   --min-severity <level> Minimum severity to keep: CRITICAL|HIGH|MEDIUM|LOW (env: SECRET_MIN_SEVERITY)
 *   -h, --help             Show help
 */

import path from 'path';
import { runSecretScanGate } from './scan.js';
import type { SecretCandidate } from './types.js';

interface CliOptions {
  directory: string;
  json: boolean;
  gitleaksBin?: string;
  trufflehogBin?: string;
  configPath?: string;
  minSeverity?: import('@secscan/shared').Severity;
  noGit: boolean;
  help: boolean;
}

function printHelp(): void {
  process.stdout.write(`\
Usage: secret-scan <directory> [options]

Run Gitleaks candidate detection + TruffleHog verification on a local directory.
Does not invoke the secret-finding-triage Cursor skill.

Options:
  --json                  Print full gate result as JSON
  --gitleaks-bin <path>   Gitleaks binary (default: gitleaks)
  --trufflehog-bin <path> TruffleHog binary (default: trufflehog)
  --config <path>         Gitleaks config (default: bundled gitleaks.toml)
  --min-severity <level>  Minimum severity to keep: CRITICAL|HIGH|MEDIUM|LOW (env: SECRET_MIN_SEVERITY)
  --no-git                Filesystem only (no git history)
  -h, --help              Show help

Examples:
  secret-scan ./my-project
  secret-scan /path/to/repo --no-git
  secret-scan . --json
  npm run cli --workspace=packages/secret-scan -- ./fixtures/sample-repo
`);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    directory: '',
    json: false,
    noGit: false,
    help: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    if (arg === '--no-git') {
      opts.noGit = true;
      continue;
    }
    if (arg === '--gitleaks-bin') {
      opts.gitleaksBin = argv[++i];
      continue;
    }
    if (arg === '--trufflehog-bin') {
      opts.trufflehogBin = argv[++i];
      continue;
    }
    if (arg === '--config') {
      opts.configPath = argv[++i];
      continue;
    }
    if (arg === '--min-severity') {
      opts.minSeverity = argv[++i] as CliOptions['minSeverity'];
      continue;
    }
    if (arg.startsWith('-')) {
      process.stderr.write(`Unknown option: ${arg}\n`);
      process.exit(1);
    }
    positional.push(arg);
  }

  opts.directory = positional[0] ?? '';
  return opts;
}

function statusLabel(status: SecretCandidate['verifyStatus']): string {
  switch (status) {
    case 'verified': return 'verified';
    case 'dead': return 'dead';
    default: return 'unverified';
  }
}

const PREVIEW_LIMIT = 5;

function printCandidateSummary(candidates: SecretCandidate[]): void {
  const byRule = new Map<string, number>();
  const bySeverity = new Map<string, number>();
  for (const c of candidates) {
    byRule.set(c.ruleId, (byRule.get(c.ruleId) ?? 0) + 1);
    bySeverity.set(c.severity, (bySeverity.get(c.severity) ?? 0) + 1);
  }

  process.stdout.write('\nBy severity:\n');
  for (const [sev, n] of [...bySeverity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    process.stdout.write(`  ${sev}: ${n}\n`);
  }

  process.stdout.write('\nBy rule:\n');
  for (const [rule, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${rule}: ${n}\n`);
  }

  const preview = candidates.slice(0, PREVIEW_LIMIT);
  if (preview.length > 0) {
    process.stdout.write(
      `\nLocations (first ${preview.length} of ${candidates.length}):\n`,
    );
    for (const c of preview) {
      process.stdout.write(
        `  ${c.path}:${c.lineStart} (${c.ruleId}, ${statusLabel(c.verifyStatus)})\n`,
      );
    }
    if (candidates.length > PREVIEW_LIMIT) {
      process.stdout.write(
        `  … and ${candidates.length - PREVIEW_LIMIT} more (use --json for full output)\n`,
      );
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || !opts.directory) {
    printHelp();
    process.exit(opts.help ? 0 : 1);
  }

  const cwd = path.resolve(opts.directory);
  const minSeverity = opts.minSeverity
    ?? (process.env.SECRET_MIN_SEVERITY as CliOptions['minSeverity'] | undefined)
    ?? 'MEDIUM';
  const redactSecrets = process.env.SECRET_REDACT === 'true';
  const log = {
    info: (msg: string) => process.stderr.write(`${msg}\n`),
    warn: (msg: string) => process.stderr.write(`WARN ${msg}\n`),
  };

  process.stderr.write(`\nsecret-scan gate — ${cwd}\n`);
  process.stderr.write(`${'─'.repeat(60)}\n`);

  const gate = await runSecretScanGate({
    cwd,
    gitleaksBin: opts.gitleaksBin,
    trufflehogBin: opts.trufflehogBin,
    configPath: opts.configPath,
    minSeverity,
    redactSecrets,
    noGit: opts.noGit,
    log,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(gate, null, 2)}\n`);
    process.exit(gate.skippedReason ? 1 : 0);
  }

  if (gate.skippedReason) {
    process.stderr.write(`\nGate failed: ${gate.skippedReason}\n`);
    process.exit(1);
  }

  const verified = gate.candidates.filter((c) => c.verifyStatus === 'verified');
  const dead = gate.candidates.filter((c) => c.verifyStatus === 'dead');
  const unverified = gate.candidates.filter((c) => c.verifyStatus === 'unverified');

  process.stdout.write(`\n${'═'.repeat(60)}\n`);
  process.stdout.write(`Gitleaks raw hits   : ${gate.gitleaksRawCount}\n`);
  process.stdout.write(`Path exclusions     : ${gate.excludedCount}\n`);
  if (gate.malformedFilteredCount) {
    process.stdout.write(`Malformed shape     : ${gate.malformedFilteredCount}\n`);
  }
  if (gate.severityFilteredCount) {
    process.stdout.write(`Below min severity  : ${gate.severityFilteredCount} (min=${minSeverity})\n`);
  }
  process.stdout.write(`Gitleaks candidates : ${gate.gitleaksCount}\n`);
  process.stdout.write(`TruffleHog matches  : ${gate.trufflehogCount}\n`);
  if (gate.trufflehogError) {
    process.stdout.write(`TruffleHog error    : ${gate.trufflehogError}\n`);
  }
  process.stdout.write(
    `Verify breakdown    : ${verified.length} verified, ${dead.length} dead, ${unverified.length} unverified\n`,
  );
  process.stdout.write(`${'═'.repeat(60)}\n`);

  if (gate.candidates.length === 0) {
    process.stdout.write('\nNo secret candidates.\n');
    return;
  }

  printCandidateSummary(gate.candidates);
  process.stdout.write('\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`secret-scan failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
