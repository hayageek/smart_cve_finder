#!/usr/bin/env node
/**
 * SecScan CLI — local test harness for the scanner & exploit worker pipeline.
 *
 * Usage:
 *   npm run cli --workspace=apps/workers -- scan <url-or-name> [options]
 *   npm run cli --workspace=apps/workers -- exploit <vuln-json-or-file> [options]
 *
 * Scan options:
 *   --type  git|npm|pip|cargo|go|gem   Source type (auto-detected for http URLs)
 *   --version <ver>                    Package version (registry packages, default: latest)
 *   --no-exploit              Skip exploit generation after scan
 *   --keep                    Keep workspace on disk after finishing
 *   --workspace <dir>         Custom workspace root (default: /tmp/secscan-cli)
 *   --skills-url <url>        Security skills repo (default: SKILLS_REPO_URL env)
 *
 * Exploit options:
 *   --source  <url|pkg>       Download source before running exploit
 *   --type    git|npm|pip|cargo|go|gem   Source type for --source (auto for http URLs)
 *   --version <ver>           Package version for --source
 *
 * Shared options:
 *   --model   <model>         Cursor model ID (default: CURSOR_AGENT_MODEL env)
 *   --fast    <true|false>    Composer 2.5 tier (default: CURSOR_AGENT_MODEL_FAST env)
 *   --api-key <key>           Cursor API key  (default: CURSOR_API_KEY env)
 *   --debug                   Print full SDK output text
 *
 * Examples:
 *   secscan scan https://github.com/hayageek/dvwa_python
 *   secscan scan express --type npm
 *   secscan scan django --type pip --version 4.2.0 --no-exploit
 *   secscan exploit '{"check_id":"py-cwe-94",...}'
 *   secscan exploit '{"check_id":"py-cwe-94",...}' --source https://github.com/hayageek/dvwa_python
 *   secscan exploit '{"check_id":"py-cwe-94",...}' --source django --type pip
 */

import { setMaxListeners } from 'events';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { mkdir, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import readline from 'readline';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { QUEUE_NAMES, type PackageType } from '@secscan/shared';
// Raise listener limit before the SDK loads (it adds AbortSignal listeners
// for each concurrent run; the default of 10 is too low).
setMaxListeners(100);
import {
  acquireSource,
  injectSkills,
  runCveScan,
  runExploitGen,
  type PipelineLogger,
} from './pipeline.js';

// Load .env from the monorepo root (not from apps/workers/ where npm sets CWD).
// import.meta.url points to the *actual* source/dist file location, so
// resolving ../../.. always reaches the repo root regardless of CWD.
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '../../..');
dotenv.config({ path: path.join(repoRoot, '.env') });

// ── ANSI helpers ──────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
};
const ts = () => new Date().toTimeString().slice(0, 8);
const pad = (s: string, n: number) => s.padEnd(n);
function printLine(level: string, color: string, ...parts: unknown[]) {
  process.stdout.write(`${C.dim}${ts()}${C.reset} ${color}${pad(level, 5)}${C.reset} `);
  console.log(...parts);
}
const log  = { 
  info:  (...a: unknown[]) => printLine('INFO', C.cyan, ...a),
  ok:    (...a: unknown[]) => printLine('OK', C.green, ...a),
  warn:  (...a: unknown[]) => printLine('WARN', C.yellow, ...a),
  error: (...a: unknown[]) => printLine('ERR', C.red, ...a),
  step:  (...a: unknown[]) => printLine('STEP', C.magenta + C.bold, ...a),
  data:  (...a: unknown[]) => printLine('DATA', C.white, ...a),
  raw:   (...a: unknown[]) => console.log(...a),
};

// ── Arg parsing ───────────────────────────────────────────────────
const argv = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return argv.includes(name);
}

const command = argv[0];

// Find the first positional argument after the command (skip flags and their values).
const VALUE_FLAGS = new Set(['--type','--source','--version','--model','--fast','--api-key',
  '--workspace','--skills-url','--skills-dir','--reports-dir','--min-severity']);

function parseFastFlag(raw: string | undefined): boolean {
  if (raw === undefined) return process.env.CURSOR_AGENT_MODEL_FAST === 'true';
  const v = raw.toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new Error(`Invalid --fast value "${raw}" (use true or false)`);
}
function firstPositional(): string | undefined {
  let skip = false;
  for (let i = 1; i < argv.length; i++) {
    if (skip)           { skip = false; continue; }
    if (VALUE_FLAGS.has(argv[i])) { skip = true;  continue; }
    if (argv[i].startsWith('--')) { continue; }
    return argv[i];
  }
  return undefined;
}
const target = firstPositional();

// Default skills dir relative to the repo root (defined earlier from import.meta.url)
const defaultSkillsDir = path.join(repoRoot, 'skills');

/**
 * Resolve a potentially-relative path against the repo root so that values
 * like SKILLS_DIR=skills or SKILLS_DIR=./skills work correctly regardless of
 * which directory npm sets as CWD when running via --workspace.
 */
function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
}

const opts = {
  type:         (getFlag('--type') ?? (target?.startsWith('http') ? 'git' : null)) as PackageType | null,
  source:       getFlag('--source'),
  version:      getFlag('--version'),
  model:        getFlag('--model')       ?? process.env.CURSOR_AGENT_MODEL ?? 'claude-sonnet-4-5',
  modelFast:    parseFastFlag(getFlag('--fast')),
  apiKey:       getFlag('--api-key')     ?? process.env.CURSOR_API_KEY,
  skillsDir:    resolveFromRoot(getFlag('--skills-dir') ?? process.env.SKILLS_DIR    ?? 'skills'),
  skillsUrl:    getFlag('--skills-url')  ?? process.env.SKILLS_REPO_URL              ?? 'https://github.com/hayageek/security_skills',
  workspace:    resolveFromRoot(getFlag('--workspace')  ?? process.env.WORKSPACES_DIR ?? './data/workspaces'),
  reportsDir:   resolveFromRoot(process.env.REPORTS_DIR ?? './data/atlassian_reports'),
  logsDir:      resolveFromRoot(process.env.LOGS_DIR    ?? './data/logs'),
  keep:         hasFlag('--keep'),
  noExploit:    hasFlag('--no-exploit'),
  debug:        hasFlag('--debug') || process.env.DEBUG_CURSOR === 'true',
};

// ── API key guard ─────────────────────────────────────────────────
if (!opts.apiKey && command !== '--help' && command !== '-h' && command) {
  console.error(
    `\x1b[33mWARN\x1b[0m  CURSOR_API_KEY is not set.\n` +
    `       Get your key at https://cursor.com/settings and add it to .env:\n` +
    `       CURSOR_API_KEY=cursor_...\n` +
    `       Or pass it inline: --api-key cursor_...\n` +
    `       \x1b[2m(env file loaded from: ${path.join(repoRoot, '.env')})\x1b[0m`,
  );
  // Continue — let the SDK throw its own error with context rather than fail silently.
}

/** Print the ── Cursor SDK … ── header before a skill run. */
function printSkillHeader(label: string, skillPath: string, cwd: string) {
  log.raw(`\n${C.bold}── Cursor SDK (${label}) ${'─'.repeat(Math.max(0, 44 - label.length))}${C.reset}`);
  log.raw(`  ${C.cyan}SKILL${C.reset} : ${skillPath}`);
  log.raw(`  ${C.cyan}MODEL${C.reset} : ${opts.model} (fast=${opts.modelFast})`);
  log.raw(`  ${C.cyan}CWD${C.reset}   : ${cwd}`);
  log.raw(`${C.bold}────────────────────────────────────────────────────────${C.reset}\n`);
}

// ── CLI logger adapter ────────────────────────────────────────────
// Adapts the colour logger to the PipelineLogger interface so pipeline
// functions can emit their messages through the CLI's display layer.
function makePipelineLogger(): PipelineLogger {
  return {
    info:  (msg) => log.info(msg),
    warn:  (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
  };
}

// ── Severity colour ───────────────────────────────────────────────
function sevColour(sev: string): string {
  switch (sev) {
    case 'CRITICAL': return C.red + C.bold;
    case 'HIGH':     return C.red;
    case 'MEDIUM':   return C.yellow;
    default:         return C.white;
  }
}

// ── SCAN command ──────────────────────────────────────────────────
async function runScan() {
  if (!target) { log.error('Usage: secscan scan <url-or-package-name> [--type npm|pip|cargo|go|gem|git]'); process.exit(1); }

  const workspacePath = path.join(opts.workspace, `scan_${Date.now()}`);
  await mkdir(workspacePath, { recursive: true });

  log.raw('\n' + C.bold + '═'.repeat(60) + C.reset);
  log.raw(`${C.bold} SecScan CLI — Scan${C.reset}`);
  log.raw(`  Target    : ${C.cyan}${target}${C.reset}`);
  log.raw(`  Type      : ${opts.type ?? 'auto'}`);
  log.raw(`  Model     : ${opts.model}`);
  log.raw(`  Workspace : ${workspacePath}`);
  log.raw(`  Reports   : ${opts.reportsDir}`);
  log.raw(`  Skills    : ${opts.skillsDir}`);
  log.raw(C.bold + '═'.repeat(60) + C.reset + '\n');

  const plog = makePipelineLogger();

  // ── Acquire source ──────────────────────────────────────────────
  log.step('1/4  Acquiring source code');

  try {
    const result = await acquireSource(
      {
        packageType: opts.type ?? 'git',
        target,
        version:  opts.version,
        destDir:  workspacePath,
      },
      plog,
    );
    if (result.isPrivate) {
      log.error('Source is private or inaccessible — cannot scan');
      process.exit(1);
    }
    if (result.resolvedVersion) log.ok(`  Resolved: ${target}@${result.resolvedVersion}`);
    if (result.repoUrl)         log.info(`  Repo URL: ${result.repoUrl}`);
  } catch (e: unknown) {
    log.error('Source acquisition failed:', (e as Error).message);
    process.exit(1);
  }

  // ── Inject skills ───────────────────────────────────────────────
  log.step('2/4  Injecting skills');
  await injectSkills(
    { workspacePath, skillsDir: opts.skillsDir, skillsRepoUrl: opts.skillsUrl, tmpDir: opts.workspace },
    plog,
  );

  // ── CVE scan ────────────────────────────────────────────────────
  log.step('3/4  Running CVE scan (streaming output below)');
  printSkillHeader('CVE scan', '/cve-pattern-hunter', workspacePath);

  let findings: unknown[];
  let drops: unknown[];
  try {
    ({ findings, drops } = await runCveScan(
      {
        cwd:              workspacePath,
        model:            opts.model,
        modelFast:        opts.modelFast,
        apiKey:           opts.apiKey,
        debug:            opts.debug,
        onChunk:          (chunk) => process.stdout.write(chunk),
        semgrepEnabled:   process.env.CVE_SEMGREP_ENABLED !== 'false',
        semgrepBin:       process.env.CVE_SEMGREP_BIN ?? 'semgrep',
        semgrepJobs:      process.env.CVE_SEMGREP_JOBS ? Number(process.env.CVE_SEMGREP_JOBS) : undefined,
      },
      plog,
    ));
    process.stdout.write('\n');
  } catch (e: unknown) {
    const err = e as { message?: string };
    log.error('CVE scan failed:', err.message);
    process.exit(1);
  }

  log.step('4/4  Parsing output');

  log.raw('\n' + C.bold + '─'.repeat(60) + C.reset);
  log.raw(`${C.bold} FINDINGS  (${findings.length})${C.reset}`);
  log.raw('─'.repeat(60) + C.reset);

  if (findings.length === 0) {
    log.raw('  No findings.\n');
  } else {
    for (const [i, f] of Object.entries(findings)) {
      const v = f as Record<string, unknown>;
      const extra = v.extra as Record<string, unknown>;
      const meta  = extra?.metadata as Record<string, unknown> ?? {};
      const sev   = String(extra?.severity ?? 'UNKNOWN');
      log.raw(`\n  ${C.bold}[${Number(i) + 1}]${C.reset} ${sevColour(sev)}${sev}${C.reset}  ${C.cyan}${v.check_id}${C.reset}`);
      log.raw(`      File    : ${v.path}:${(v.start as Record<string,number>)?.line}`);
      log.raw(`      CWE     : ${meta.cwe}  (${meta.vulnerability_type})`);
      log.raw(`      Message : ${extra?.message}`);
      log.raw(`      CVSS    : ${meta.confidence} confidence`);
    }
  }

  log.raw('\n' + C.bold + '─'.repeat(60) + C.reset);
  log.raw(`${C.bold} DROPPED   (${drops.length})${C.reset}`);
  log.raw('─'.repeat(60) + C.reset);

  if (drops.length === 0) {
    log.raw('  None.\n');
  } else {
    for (const [i, d] of Object.entries(drops)) {
      const dr = d as Record<string, unknown>;
      log.raw(`\n  ${C.bold}[${Number(i) + 1}]${C.reset} ${C.dim}${dr.check_id}${C.reset}`);
      log.raw(`      File  : ${dr.path}:${dr.line}`);
      log.raw(`      CWE   : ${dr.cwe}`);
      log.raw(`      Reason: ${dr.drop_reason}`);
      log.raw(`      Detail: ${dr.drop_evidence}`);
    }
  }

  // ── Exploit generation ───────────────────────────────────────────
  if (!opts.noExploit && findings.length > 0) {
    log.raw('\n' + C.bold + '─'.repeat(60) + C.reset);
    log.raw(`${C.bold} EXPLOIT GENERATION${C.reset}`);
    log.raw('─'.repeat(60));

    for (const [i, f] of Object.entries(findings)) {
      const v = f as Record<string, unknown>;
      const extra = v.extra as Record<string, unknown>;
      const sev = String(extra?.severity ?? '');
      if (!['CRITICAL', 'HIGH'].includes(sev)) {
        log.info(`  [${Number(i) + 1}] Skipping ${sev} finding (below threshold)`);
        continue;
      }

      log.info(`\n  [${Number(i) + 1}] Generating exploit for ${v.check_id}`);
      const vulnJson = JSON.stringify(v);
      if (opts.debug) { log.raw(`  ${C.cyan}VULN JSON${C.reset}: ${vulnJson}`); }

      printSkillHeader(`exploit [${Number(i) + 1}]`, '/exploit-generator', workspacePath);
      try {
        const { exploitResult } = await runExploitGen(
          {
            vulnJson,
            cwd:     workspacePath,
            destDir: path.join(opts.reportsDir, (v as Record<string, unknown>).finding_id as string),
            model:     opts.model,
            modelFast: opts.modelFast,
            apiKey:  opts.apiKey,
            debug:   opts.debug,
            onChunk: (chunk) => process.stdout.write(chunk),
          },
          plog,
        );
        process.stdout.write('\n');
        if (exploitResult) {
          log.info(`  Result: ${exploitResult.result}  (${exploitResult.attempts ?? '?'} attempts)`);
        }
      } catch (e: unknown) {
        const err = e as { message?: string };
        log.error(`  Exploit generation failed: ${err.message}`);
      }
    }
  } else if (opts.noExploit) {
    log.info('Exploit generation skipped (--no-exploit)');
  }

  // ── Summary ──────────────────────────────────────────────────────
  log.raw('\n' + C.bold + '═'.repeat(60) + C.reset);
  log.raw(`${C.bold} SUMMARY${C.reset}`);
  log.raw(`  Findings : ${C.green}${findings.length}${C.reset}`);
  log.raw(`  Dropped  : ${C.dim}${drops.length}${C.reset}`);
  log.raw(`  Workspace: ${workspacePath}`);
  log.raw(C.bold + '═'.repeat(60) + C.reset + '\n');

  if (!opts.keep) {
    log.info('Cleaning up workspace (use --keep to preserve)');
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
  }
}

// ── EXPLOIT command ───────────────────────────────────────────────
async function runExploit() {
  if (!target) { log.error('Usage: secscan exploit <vuln-json-string-or-file> [options]'); process.exit(1); }

  let vulnJson = target;
  // If it looks like a file path, read it
  if (!target.startsWith('{') && existsSync(target)) {
    vulnJson = await readFile(target, 'utf-8');
    log.info(`Loaded vuln JSON from file: ${target}`);
  }

  let parsedVuln: Record<string, unknown> = {};
  try { parsedVuln = JSON.parse(vulnJson); } catch { /* malformed */ }
  console.log(vulnJson)
  const findingId = parsedVuln.finding_id as string | undefined;
  if (!findingId) {
    log.error('vuln JSON is missing required field: finding_id');
    process.exit(1);
  }

  const workspacePath = path.join(opts.workspace, findingId);
  await mkdir(workspacePath, { recursive: true });

  // Resolve source type: --source may be a URL (auto → git) or package name (needs --type)
  const sourceTarget = opts.source;
  const sourceType   = (opts.type ?? (sourceTarget?.startsWith('http') ? 'git' : null)) as PackageType | null;

  log.raw('\n' + C.bold + '═'.repeat(60) + C.reset);
  log.raw(`${C.bold} SecScan CLI — Exploit Generator${C.reset}`);
  log.raw(`  Model   : ${opts.model}`);
  log.raw(`  Scratch : ${workspacePath}`);
  log.raw(`  Reports : ${opts.reportsDir}`);
  if (sourceTarget) {
    log.raw(`  Source  : ${C.cyan}${sourceTarget}${C.reset}  (type: ${sourceType ?? 'auto'})`);
  }
  log.raw(C.bold + '═'.repeat(60) + C.reset + '\n');

  const plog = makePipelineLogger();

  // ── Acquire source (if --source was provided) ──────────────────
  if (sourceTarget) {
    if (!sourceType) {
      log.error('Cannot determine source type. Pass --type git|npm|pip|cargo|go|gem alongside --source.');
      process.exit(1);
    }
    log.step('1/3  Acquiring source code');
    try {
      const result = await acquireSource(
        {
          packageType: sourceType,
          target:      sourceTarget,
          version:     opts.version,
          destDir:     workspacePath,
        },
        plog,
      );
      if (result.isPrivate) {
        log.error('Source is private or inaccessible — cannot exploit');
        process.exit(1);
      }
      if (result.resolvedVersion) log.ok(`  Resolved: ${sourceTarget}@${result.resolvedVersion}`);
      if (result.repoUrl)         log.info(`  Repo URL: ${result.repoUrl}`);
    } catch (e: unknown) {
      log.error('Source acquisition failed:', (e as Error).message);
      process.exit(1);
    }
  }

  const skillStepNum = sourceTarget ? '2/3' : '1/2';
  const exploitStepNum = sourceTarget ? '3/3' : '2/2';

  log.step(`${skillStepNum}  Injecting skills`);
  await injectSkills(
    { workspacePath, skillsDir: opts.skillsDir, skillsRepoUrl: opts.skillsUrl, tmpDir: opts.workspace },
    plog,
  );

  log.step(`${exploitStepNum}  Running exploit-generator (streaming output below)`);
  if (opts.debug) log.raw(`  ${C.cyan}VULN JSON${C.reset}: ${vulnJson}`);

  const exploitDestDir = path.join(opts.reportsDir, findingId);
  log.info(`  Output  : ${exploitDestDir}`);

  printSkillHeader('exploit-generator', '/exploit-generator', workspacePath);
  try {
    const { exploitResult, artifacts } = await runExploitGen(
      {
        vulnJson,
        cwd:     workspacePath,
        destDir: exploitDestDir,
        model:     opts.model,
        modelFast: opts.modelFast,
        apiKey:  opts.apiKey,
        debug:   opts.debug,
        onChunk: (chunk) => process.stdout.write(chunk),
      },
      plog,
    );
    process.stdout.write('\n');

    if (exploitResult) {
      log.info(`  Result   : ${exploitResult.result}`);
      log.info(`  Attempts : ${exploitResult.attempts ?? '?'}`);

      for (const [, dest] of Object.entries(artifacts)) {
        if (!dest) continue;
        const fname = path.basename(dest);
        const content = await readFile(dest, 'utf-8').catch(() => '(binary or unreadable)');
        log.raw('\n' + C.bold + `── ${fname} ${'─'.repeat(Math.max(0, 50 - fname.length))}` + C.reset);
        log.raw(content);
      }
    }
  } catch (e: unknown) {
    const err = e as { message?: string };
    log.error('exploit-generator failed:', err.message);
    process.exit(1);
  }

  if (!opts.keep) {
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
  }
}

// ── QUEUE-EXPLOIT command ─────────────────────────────────────────
async function queueExploit() {
  // ── Parse filters ────────────────────────────────────────────────
  const severityRaw    = getFlag('--severity') ?? 'CRITICAL,HIGH';
  const severities     = severityRaw.split(',').map((s) => s.trim().toUpperCase());
  const repoFilter     = getFlag('--repo');
  const orgFilter      = getFlag('--org');
  const packageFilter  = getFlag('--package');
  const includeDropped = hasFlag('--include-dropped');
  const dryRun         = hasFlag('--dry-run');
  const skipConfirm    = hasFlag('--yes') || hasFlag('-y');
  const onlyNew        = !hasFlag('--no-only-new');

  // ── Build Prisma where ────────────────────────────────────────────
  const repoWhere: Record<string, unknown> = {};
  if (repoFilter)    repoWhere.url         = { contains: repoFilter,   mode: 'insensitive' };
  if (orgFilter)     repoWhere.url         = { contains: `/${orgFilter}/`, mode: 'insensitive' };
  if (packageFilter) repoWhere.packageName = { contains: packageFilter, mode: 'insensitive' };

  const where: Record<string, unknown> = {
    severity:        { in: severities },
    isFalsePositive: false,
    ...(onlyNew        ? { exploitStatus: null } : {}),
    ...(!includeDropped ? { dropped: false }     : {}),
    ...(Object.keys(repoWhere).length
      ? { scanJob: { repo: repoWhere } }
      : {}),
  };

  // ── Query DB ──────────────────────────────────────────────────────
  const prisma = new PrismaClient();
  let vulns: Awaited<ReturnType<typeof prisma.vulnerability.findMany<{
    include: { scanJob: { include: { repo: true } } }
  }>>>;

  try {
    vulns = await prisma.vulnerability.findMany({
      where,
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
      include: { scanJob: { include: { repo: true } } },
    });
  } catch (e: unknown) {
    log.error('DB query failed:', (e as Error).message);
    log.error('Make sure DATABASE_URL is set and the database is reachable.');
    await prisma.$disconnect();
    process.exit(1);
  }

  // ── Header ────────────────────────────────────────────────────────
  log.raw('\n' + C.bold + '═'.repeat(72) + C.reset);
  log.raw(`${C.bold} SecScan CLI — Queue Exploit${C.reset}`);
  log.raw(`  Severity       : ${C.cyan}${severities.join(', ')}${C.reset}`);
  if (repoFilter)    log.raw(`  Repo filter    : ${repoFilter}`);
  if (orgFilter)     log.raw(`  Org filter     : ${orgFilter}`);
  if (packageFilter) log.raw(`  Package filter : ${packageFilter}`);
  log.raw(`  Include dropped: ${includeDropped ? 'yes' : 'no'}`);
  log.raw(`  Only new       : ${onlyNew ? 'yes (no existing exploit status)' : 'no'}`);
  log.raw(`  Mode           : ${dryRun ? C.yellow + 'DRY RUN' + C.reset : C.green + 'LIVE' + C.reset}`);
  log.raw(C.bold + '═'.repeat(72) + C.reset);

  if (vulns.length === 0) {
    log.warn('No vulnerabilities match the given filters.');
    await prisma.$disconnect();
    return;
  }

  // ── Preview table ─────────────────────────────────────────────────
  const SEV_W = 10, CWE_W = 12, FILE_W = 28, REPO_W = 30, ID_W = 16;
  const row = (sev: string, cwe: string, file: string, repo: string, id: string) =>
    `  ${sevColour(sev)}${sev.padEnd(SEV_W)}${C.reset}` +
    `${cwe.padEnd(CWE_W)}` +
    `${C.dim}${file.slice(-FILE_W).padEnd(FILE_W)}${C.reset}  ` +
    `${repo.replace('https://', '').slice(0, REPO_W).padEnd(REPO_W)}  ` +
    `${C.dim}…${id.slice(-ID_W)}${C.reset}`;

  log.raw('');
  log.raw(`  ${'SEVERITY'.padEnd(SEV_W)}${'CWE'.padEnd(CWE_W)}${'FILE:LINE'.padEnd(FILE_W)}  ${'REPO'.padEnd(REPO_W)}  FINDING ID`);
  log.raw('  ' + '─'.repeat(SEV_W + CWE_W + FILE_W + REPO_W + ID_W + 6));

  for (const v of vulns) {
    const file = `${v.path}:${v.lineStart}`;
    const repo = v.scanJob.repo.url;
    log.raw(row(v.severity, v.cwe, file, repo, v.id));
  }

  log.raw('');
  log.raw(`  ${C.bold}Total: ${vulns.length} vulnerability/ies${C.reset}`);
  log.raw('');

  if (dryRun) {
    log.info('Dry run — nothing queued. Remove --dry-run to queue.');
    await prisma.$disconnect();
    return;
  }

  // ── Confirm ───────────────────────────────────────────────────────
  if (!skipConfirm) {
    const confirmed = await new Promise<boolean>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(
        `${C.yellow}Queue ${vulns.length} exploit job(s)? [y/N] ${C.reset}`,
        (ans) => { rl.close(); resolve(ans.trim().toLowerCase() === 'y'); },
      );
    });
    if (!confirmed) {
      log.info('Aborted.');
      await prisma.$disconnect();
      return;
    }
  }

  // ── Enqueue ───────────────────────────────────────────────────────
  const redisConn = {
    host:     process.env.REDIS_HOST     ?? 'localhost',
    port:     parseInt(process.env.REDIS_PORT ?? '6379', 10),
    ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
    maxRetriesPerRequest: null as null,
  };

  const exploitQueue = new Queue(QUEUE_NAMES.EXPLOIT_GEN, { connection: redisConn });

  // Mark all as pending in one query
  await prisma.vulnerability.updateMany({
    where: { id: { in: vulns.map((v) => v.id) } },
    data:  { exploitStatus: 'pending', exploitError: null },
  });

  let queued = 0;
  for (const v of vulns) {
    const repo = v.scanJob.repo;
    await exploitQueue.add('exploit', {
      vulnId:        v.id,
      scanJobId:     v.scanJobId,
      vulnJson:      (v.metadataJson ?? {}) as never,
      sourceAcquisition: {
        packageType: (repo.packageType as PackageType) ?? 'git',
        target:      repo.packageName ?? repo.url,
        version:     repo.packageVersion ?? undefined,
      },
    });
    log.ok(`  Queued ${v.id.slice(-12)}  ${sevColour(v.severity)}${v.severity}${C.reset}  ${v.cwe}  ${v.path}:${v.lineStart}`);
    queued++;
  }

  await exploitQueue.close();
  await prisma.$disconnect();

  log.raw('\n' + C.bold + '═'.repeat(72) + C.reset);
  log.raw(`${C.bold} ${C.green}✓ Queued ${queued} exploit job(s)${C.reset}`);
  log.raw(`  Workers will pick them up automatically.`);
  log.raw(C.bold + '═'.repeat(72) + C.reset + '\n');
}

// ── Entry point ───────────────────────────────────────────────────
if (!command || command === '--help' || command === '-h') {
  log.raw(`
${C.bold}SecScan CLI${C.reset}

Commands:
  ${C.cyan}scan <url|package>${C.reset}        Scan a git repo or registry package
  ${C.cyan}exploit <json|file>${C.reset}       Run exploit-generator on a vuln JSON
  ${C.cyan}queue-exploit${C.reset}             Select vulns from the DB and push to exploit queue

Scan options:
  --type  git|npm|pip|cargo|go|gem   Source type  (auto for http URLs)
  --version <ver>                    Package version (registry packages, default: latest)
  --no-exploit                 Skip exploit generation
  --keep                       Keep workspace on disk

Exploit options:
  --source <url|pkg>           Download source before running exploit
  --type   git|npm|pip|cargo|go|gem   Source type for --source (auto-detected for http URLs)
  --version <ver>              Package version for --source

Queue-exploit options:
  --severity <list>            Comma-separated severities  (default: CRITICAL,HIGH)
  --repo <pattern>             Filter by repo URL substring  (e.g. "dvwa_python")
  --org <org>                  Filter by GitHub/GitLab org   (e.g. "hayageek")
  --package <name>             Filter by package name substring
  --include-dropped            Also queue dropped findings
  --no-only-new                Re-queue findings that already have an exploit status
  --dry-run                    Preview matching vulns without queuing
  -y, --yes                    Skip confirmation prompt

Shared options:
  --model     <model>          Cursor model ID         (env: CURSOR_AGENT_MODEL, default: claude-sonnet-4-5)
  --fast      <true|false>     Composer 2.5 fast tier  (env: CURSOR_AGENT_MODEL_FAST, default: false)
  --api-key   <key>            Cursor API key          (env: CURSOR_API_KEY)
  --workspace <dir>            Working directory       (default: /tmp/secscan-cli)
  --skills-dir <dir>           Local skills folder     (env: SKILLS_DIR, default: ./skills)
  --skills-url <url>           Fallback skills git URL (env: SKILLS_REPO_URL)

Examples:
  ${C.dim}# Git repo${C.reset}
  npm run cli -w apps/workers -- scan https://github.com/hayageek/dvwa_python

  ${C.dim}# npm package (latest)${C.reset}
  npm run cli -w apps/workers -- scan express --type npm

  ${C.dim}# pip package (pinned version, no exploit)${C.reset}
  npm run cli -w apps/workers -- scan django --type pip --version 4.2.0 --no-exploit

  ${C.dim}# exploit only (no source — skill must work without source)${C.reset}
  npm run cli -w apps/workers -- exploit ./vuln.json

  ${C.dim}# exploit with source download (git)${C.reset}
  npm run cli -w apps/workers -- exploit ./vuln.json --source https://github.com/hayageek/dvwa_python

  ${C.dim}# exploit with source download (pip package)${C.reset}
  npm run cli -w apps/workers -- exploit ./vuln.json --source django --type pip --version 4.2.0

  ${C.dim}# queue all CRITICAL+HIGH vulns from a specific org (dry run first)${C.reset}
  npm run cli -w apps/workers -- queue-exploit --org hayageek --dry-run
  npm run cli -w apps/workers -- queue-exploit --org hayageek --yes

  ${C.dim}# queue CRITICAL-only vulns for a specific repo${C.reset}
  npm run cli -w apps/workers -- queue-exploit --severity CRITICAL --repo dvwa_python

  ${C.dim}# queue by package name, include dropped, skip confirm${C.reset}
  npm run cli -w apps/workers -- queue-exploit --package django --include-dropped -y
`);
  process.exit(0);
}

switch (command) {
  case 'scan':          runScan().catch(e         => { log.error(e); process.exit(1); }); break;
  case 'exploit':       runExploit().catch(e      => { log.error(e); process.exit(1); }); break;
  case 'queue-exploit': queueExploit().catch(e    => { log.error(e); process.exit(1); }); break;
  default:
    log.error(`Unknown command: ${command}. Use 'scan', 'exploit', or 'queue-exploit'.`);
    process.exit(1);
}
