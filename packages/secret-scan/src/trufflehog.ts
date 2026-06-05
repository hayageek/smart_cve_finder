import { execFile } from 'child_process';
import { promisify } from 'util';
import type { TrufflehogMatch } from './types.js';
import { normalizeScanPath } from './gitleaks.js';
import { formatExecCommand, truncateForLog } from './exec-log.js';

const execFileAsync = promisify(execFile);

async function trufflehogAvailable(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    try {
      await execFileAsync(bin, ['version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

export interface RunTrufflehogOptions {
  cwd: string;
  trufflehogBin?: string;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Run TruffleHog filesystem scan with verification enabled.
 * Returns verified/unverified matches keyed by file + line.
 */
export async function runTrufflehogVerify(opts: RunTrufflehogOptions): Promise<TrufflehogMatch[]> {
  const bin = opts.trufflehogBin ?? 'trufflehog';
  if (!(await trufflehogAvailable(bin))) {
    throw new Error(`trufflehog not found at "${bin}" — install from https://github.com/trufflesecurity/trufflehog`);
  }

  const args = [
    'filesystem',
    opts.cwd,
    '--json',
    '--verify',
    '--no-update',
  ];

  const log = opts.log;
  const started = Date.now();
  log?.info(`[trufflehog] verify starting — cwd=${opts.cwd}`);

  const cmd = formatExecCommand(bin, args);
  log?.info(`[trufflehog] exec: ${cmd}`);

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(bin, args, {
      cwd: opts.cwd,
      maxBuffer: 50 * 1024 * 1024,
      timeout: 900_000,
      env: { ...process.env, TRUFFLEHOG_NO_UPDATE: '1' },
    }));
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    if (execErr.stdout?.trim()) {
      stdout = execErr.stdout;
    } else {
      const detail = execErr.stderr ? truncateForLog(execErr.stderr) : String(execErr.message ?? err);
      log?.warn(`[trufflehog] verify failed: ${detail}`);
      throw new Error(`trufflehog failed: ${execErr.stderr ?? execErr.message ?? err}`);
    }
  }

  const matches: TrufflehogMatch[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('{"level"')) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const sourceMeta = row.SourceMetadata as Record<string, unknown> | undefined;
    const data = sourceMeta?.Data as Record<string, unknown> | undefined;
    const fs = data?.Filesystem as Record<string, unknown> | undefined;
    const file = String(fs?.file ?? fs?.File ?? '');
    const lineNum = Number(fs?.line ?? fs?.Line ?? 0);
    if (!file || !lineNum) continue;

    matches.push({
      file: normalizeScanPath(opts.cwd, file),
      line: lineNum,
      detectorName: String(row.DetectorName ?? row.detector_name ?? 'unknown'),
      verified: Boolean(row.Verified ?? row.verified),
      redacted: String(row.Redacted ?? row.redacted ?? ''),
    });
  }

  const verified = matches.filter((m) => m.verified).length;
  log?.info(
    `[trufflehog] verify complete — ${matches.length} match(es) (${verified} verified) in ${Date.now() - started}ms`,
  );

  return matches;
}

/** Match trufflehog results to a gitleaks hit by file path and line proximity (±2 lines). */
export function findTrufflehogMatch(
  thMatches: TrufflehogMatch[],
  file: string,
  line: number,
): TrufflehogMatch | undefined {
  return thMatches.find(
    (m) => m.file === file && Math.abs(m.line - line) <= 2,
  );
}
