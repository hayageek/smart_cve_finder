import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import type { GitleaksMatch } from './types.js';
import { formatExecCommand, truncateForLog } from './exec-log.js';

const execFileAsync = promisify(execFile);

export function defaultConfigPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'gitleaks.toml'),
    path.join(here, '..', 'gitleaks.toml'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

async function gitleaksAvailable(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ['version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export interface RunGitleaksOptions {
  cwd: string;
  gitleaksBin?: string;
  configPath?: string;
  noGit?: boolean;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export async function runGitleaksScan(opts: RunGitleaksOptions): Promise<GitleaksMatch[]> {
  const bin = opts.gitleaksBin ?? 'gitleaks';
  if (!(await gitleaksAvailable(bin))) {
    throw new Error(`gitleaks not found at "${bin}" — install from https://github.com/gitleaks/gitleaks`);
  }

  const configPath = opts.configPath ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`gitleaks config not found: ${configPath}`);
  }

  const reportDir = await mkdtemp(path.join(tmpdir(), 'gitleaks-'));
  const reportPath = path.join(reportDir, 'report.json');
  const log = opts.log;
  const started = Date.now();

  log?.info(
    `[gitleaks] detect starting — cwd=${opts.cwd} noGit=${opts.noGit !== false} config=${configPath}`,
  );

  const args = [
    'detect',
    '--source', opts.cwd,
    '--config', configPath,
    '--report-format', 'json',
    '--report-path', reportPath,
    '--exit-code', '0',
    '--no-banner',
  ];
  if (opts.noGit !== false) {
    args.push('--no-git');
  }

  const cmd = formatExecCommand(bin, args);
  log?.info(`[gitleaks] exec: ${cmd}`);

  let stdout = '';
  try {
    try {
      ({ stdout } = await execFileAsync(bin, args, {
        cwd: opts.cwd,
        maxBuffer: 50 * 1024 * 1024,
        timeout: 600_000,
      }));
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      // gitleaks may exit non-zero when findings exist; still parse report if written
      if (execErr.stdout?.trim()) {
        stdout = execErr.stdout;
      } else if (!existsSync(reportPath)) {
        const detail = execErr.stderr ? truncateForLog(execErr.stderr) : String(execErr.message ?? err);
        log?.warn(`[gitleaks] detect failed: ${detail}`);
        throw new Error(`gitleaks failed: ${execErr.stderr ?? execErr.message ?? err}`);
      }
    }

    if (existsSync(reportPath)) {
      stdout = await readFile(reportPath, 'utf8');
    }

    if (stdout === '' && existsSync(reportPath)) {
      log?.info(`[gitleaks] report file empty (${reportPath})`);
    }
  } finally {
    await rm(reportDir, { recursive: true, force: true }).catch(() => {});
  }

  const trimmed = stdout.trim();
  if (!trimmed || trimmed === '[]' || trimmed === 'null') {
    log?.info(`[gitleaks] detect complete — 0 match(es) in ${Date.now() - started}ms`);
    return [];
  }

  let matches: GitleaksMatch[];
  try {
    const parsed = JSON.parse(trimmed) as GitleaksMatch[];
    matches = Array.isArray(parsed) ? parsed : [];
  } catch {
    // Some gitleaks versions write to stderr or use NDJSON
    const lines = trimmed.split('\n').filter(Boolean);
    matches = [];
    for (const line of lines) {
      try {
        matches.push(JSON.parse(line) as GitleaksMatch);
      } catch {
        // ignore non-json lines
      }
    }
  }

  const sample = matches
    .slice(0, 3)
    .map((m) => `${normalizeScanPath(opts.cwd, m.File)}:${m.StartLine} (${m.RuleID})`)
    .join('; ');
  log?.info(
    `[gitleaks] detect complete — ${matches.length} match(es) in ${Date.now() - started}ms` +
      (sample ? ` — ${sample}${matches.length > 3 ? '…' : ''}` : ''),
  );
  return matches;
}

/** Normalize file paths from scanners to workspace-relative posix paths. */
export function normalizeScanPath(cwd: string, filePath: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  let rel = path.relative(cwd, abs);
  if (rel.startsWith('..')) rel = filePath.replace(/\\/g, '/');
  return rel.replace(/\\/g, '/');
}

export function loadConfigText(configPath?: string): string {
  const p = configPath ?? defaultConfigPath();
  return readFileSync(p, 'utf8');
}
