import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { SEVERITY_ORDER, type Severity } from '@secscan/shared';
import type { GitleaksMatch, SecretCandidate, SecretScanGateResult, SecretScanOptions, VerifyStatus } from './types.js';
import { runGitleaksScan, normalizeScanPath } from './gitleaks.js';
import { findTrufflehogMatch, runTrufflehogVerify } from './trufflehog.js';
import { redactSecret } from './redact.js';
import { isExcludedPath } from './exclusions.js';
import { isInvalidSecretShape } from './validate.js';
import { isCommentedSecretLine, readLineAt } from './comment.js';

/** Above this raw gitleaks count, hits are treated as test/fixture noise (e.g. OpenAPI examples). */
export const DEFAULT_MAX_GITLEAKS_RAW_HITS = 20;

const CRITICAL_RULES = new Set([
  'aws-secret-access-key',
  'aws-access-key-id',
  'private-key',
  'github-pat',
  'github-oauth',
  'gitlab-pat',
  'slack-webhook',
  'stripe-secret-key',
  'openai-api-key',
  'anthropic-api-key',
]);

const HIGH_RULES = new Set([
  'generic-api-key',
  'jwt',
  'npm-access-token',
  'pypi-api-token',
  'docker-config',
  'database-url',
  'connection-string',
  'sendgrid-api-token',
  'twilio-api-key',
]);

function severityForRule(ruleId: string, verified: boolean): Severity {
  const id = ruleId.toLowerCase();
  if (CRITICAL_RULES.has(id) || id.includes('private-key') || id.includes('secret-access')) {
    return verified ? 'CRITICAL' : 'HIGH';
  }
  if (HIGH_RULES.has(id) || id.includes('api-key') || id.includes('token') || id.includes('password')) {
    return verified ? 'HIGH' : 'MEDIUM';
  }
  return verified ? 'MEDIUM' : 'LOW';
}

function verifyStatusFromTrufflehog(th?: { verified: boolean }): VerifyStatus {
  if (!th) return 'unverified';
  return th.verified ? 'verified' : 'dead';
}

function passesMinSeverity(severity: Severity, minSeverity?: Severity): boolean {
  if (!minSeverity || minSeverity === 'LOW') return true;
  return (SEVERITY_ORDER[severity] ?? 0) >= (SEVERITY_ORDER[minSeverity] ?? 0);
}

function isRedactedPlaceholder(value: string): boolean {
  const v = value.trim();
  if (!v || v === 'REDACTED') return true;
  if (/^\*+$/.test(v)) return true;
  // Our redactSecret() output or similar partial masks
  if (/\*{4,}/.test(v)) return true;
  return false;
}

/** Read the matched substring from the scanned file (gitleaks columns are 1-based). */
function readSecretFromSource(cwd: string, gl: GitleaksMatch): string | undefined {
  try {
    const absPath = path.isAbsolute(gl.File) ? gl.File : path.join(cwd, gl.File);
    if (!existsSync(absPath)) return undefined;
    const lines = readFileSync(absPath, 'utf8').split(/\r?\n/);
    const startIdx = gl.StartLine - 1;
    if (startIdx < 0 || startIdx >= lines.length) return undefined;

    if (gl.StartColumn && gl.EndColumn && gl.EndColumn > gl.StartColumn) {
      const slice = lines[startIdx].slice(gl.StartColumn - 1, gl.EndColumn);
      if (slice.trim()) return slice;
    }

    const endIdx = (gl.EndLine ?? gl.StartLine) - 1;
    if (endIdx > startIdx && endIdx < lines.length) {
      const block = lines.slice(startIdx, endIdx + 1).join('\n');
      if (block.trim()) return block;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function resolveSecretValue(cwd: string, gl: GitleaksMatch, redactForStorage: boolean): string {
  const fromReport = (gl.Secret || gl.Match || '').trim();
  let full = fromReport;

  if (isRedactedPlaceholder(fromReport)) {
    const fromSource = readSecretFromSource(cwd, gl);
    if (fromSource?.trim()) full = fromSource.trim();
  }

  if (!full && !isRedactedPlaceholder(fromReport)) {
    full = fromReport;
  }

  return redactForStorage ? redactSecret(full) : full;
}

function toCandidate(
  cwd: string,
  gl: GitleaksMatch,
  verifyStatus: VerifyStatus,
  detectorName?: string,
  redactForStorage = false,
): SecretCandidate {
  const relPath = normalizeScanPath(cwd, gl.File);
  const secretValue = resolveSecretValue(cwd, gl, redactForStorage);
  return {
    ruleId: gl.RuleID,
    description: gl.Description,
    path: relPath,
    lineStart: gl.StartLine,
    lineEnd: gl.EndLine || gl.StartLine,
    startColumn: gl.StartColumn,
    secretType: gl.RuleID,
    redactedValue: secretValue,
    entropy: gl.Entropy,
    verifyStatus,
    detectorName,
    severity: severityForRule(gl.RuleID, verifyStatus === 'verified'),
  };
}

/**
 * Gitleaks candidate enumeration + TruffleHog verification merge.
 * Does NOT run Cursor triage — callers handle unverified candidates separately.
 */
export async function runSecretScanGate(opts: SecretScanOptions): Promise<SecretScanGateResult> {
  const log = opts.log;

  let gitleaksMatches: GitleaksMatch[];
  try {
    gitleaksMatches = await runGitleaksScan({
      cwd: opts.cwd,
      gitleaksBin: opts.gitleaksBin,
      configPath: opts.configPath,
      noGit: opts.noGit,
      redact: opts.redactSecrets === true,
      log: opts.log,
    });
  } catch (err) {
    const msg = String(err);
    log?.warn(`[secret-scan] gitleaks gate failed: ${msg}`);
    return {
      candidates: [],
      commentedCandidates: [],
      gitleaksCount: 0,
      gitleaksRawCount: 0,
      excludedCount: 0,
      malformedFilteredCount: 0,
      trufflehogCount: 0,
      skippedReason: msg,
    };
  }

  const gitleaksRawCount = gitleaksMatches.length;
  const maxRawHits = opts.maxGitleaksRawHits ?? DEFAULT_MAX_GITLEAKS_RAW_HITS;
  if (gitleaksRawCount > maxRawHits) {
    log?.info(
      `[secret-scan] gate complete — skipping ${gitleaksRawCount} gitleaks hit(s) ` +
        `(>${maxRawHits} threshold; likely test/fixture/spec data, not actionable secrets)`,
    );
    return {
      candidates: [],
      commentedCandidates: [],
      gitleaksCount: 0,
      gitleaksRawCount,
      excludedCount: 0,
      malformedFilteredCount: 0,
      trufflehogCount: 0,
    };
  }

  let excludedCount = 0;
  let malformedFilteredCount = 0;
  gitleaksMatches = gitleaksMatches.filter((gl) => {
    const relPath = normalizeScanPath(opts.cwd, gl.File);
    if (isExcludedPath(relPath)) {
      excludedCount++;
      return false;
    }
    const raw = resolveSecretValue(opts.cwd, gl, false);
    if (isInvalidSecretShape(raw)) {
      malformedFilteredCount++;
      return false;
    }
    return true;
  });

  if (excludedCount > 0) {
    log?.info(`[secret-scan] path exclusions removed ${excludedCount} gitleaks hit(s)`);
  }
  if (malformedFilteredCount > 0) {
    log?.info(
      `[secret-scan] malformed secret shape removed ${malformedFilteredCount} gitleaks hit(s) ` +
        '(value contained structural chars or a multi-segment path)',
    );
  }

  if (gitleaksMatches.length === 0) {
    log?.info(
      `[secret-scan] gate complete — no candidates after gitleaks` +
        (gitleaksRawCount > 0 ? ` (${gitleaksRawCount} raw hit(s) excluded)` : ''),
    );
    return {
      candidates: [],
      commentedCandidates: [],
      gitleaksCount: 0,
      gitleaksRawCount,
      excludedCount,
      malformedFilteredCount,
      trufflehogCount: 0,
    };
  }

  let trufflehogMatches: Awaited<ReturnType<typeof runTrufflehogVerify>> = [];
  let trufflehogError: string | undefined;
  try {
    trufflehogMatches = await runTrufflehogVerify({
      cwd: opts.cwd,
      trufflehogBin: opts.trufflehogBin,
      log: opts.log,
    });
  } catch (err) {
    trufflehogError = String(err);
    log?.warn(`[secret-scan] trufflehog unavailable — candidates stay unverified: ${trufflehogError}`);
  }

  let candidates: SecretCandidate[] = gitleaksMatches.map((gl) => {
    const relPath = normalizeScanPath(opts.cwd, gl.File);
    const th = findTrufflehogMatch(trufflehogMatches, relPath, gl.StartLine);
    const status = verifyStatusFromTrufflehog(th);
    return toCandidate(opts.cwd, gl, status, th?.detectorName, opts.redactSecrets);
  });

  const commentedCandidates: SecretCandidate[] = [];
  candidates = candidates.filter((c) => {
    const line = readLineAt(opts.cwd, c.path, c.lineStart);
    if (line !== undefined && isCommentedSecretLine(line, c.startColumn)) {
      commentedCandidates.push(c);
      return false;
    }
    return true;
  });

  if (commentedCandidates.length > 0) {
    log?.info(`[secret-scan] commented line filter removed ${commentedCandidates.length} candidate(s)`);
  }

  let severityFilteredCount = 0;
  if (opts.minSeverity && opts.minSeverity !== 'LOW') {
    const before = candidates.length;
    candidates = candidates.filter((c) => passesMinSeverity(c.severity, opts.minSeverity));
    severityFilteredCount = before - candidates.length;
    if (severityFilteredCount > 0) {
      log?.info(
        `[secret-scan] severity filter (>= ${opts.minSeverity}) removed ${severityFilteredCount} candidate(s)`,
      );
    }
  }

  const verified = candidates.filter((c) => c.verifyStatus === 'verified').length;
  const dead = candidates.filter((c) => c.verifyStatus === 'dead').length;
  const unverified = candidates.filter((c) => c.verifyStatus === 'unverified').length;
  log?.info(
    `[secret-scan] gate complete — ${candidates.length} candidate(s): ` +
      `${verified} verified, ${dead} dead, ${unverified} unverified`,
  );

  return {
    candidates,
    commentedCandidates,
    gitleaksCount: gitleaksMatches.length,
    gitleaksRawCount,
    excludedCount,
    malformedFilteredCount,
    commentedCount: commentedCandidates.length,
    trufflehogCount: trufflehogMatches.length,
    trufflehogError,
    severityFilteredCount,
  };
}

export type { SecretCandidate, SecretScanGateResult, SecretScanOptions, VerifyStatus };
