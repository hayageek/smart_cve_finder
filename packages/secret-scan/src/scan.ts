import type { Severity } from '@secscan/shared';
import type { GitleaksMatch, SecretCandidate, SecretScanGateResult, SecretScanOptions, VerifyStatus } from './types.js';
import { runGitleaksScan, normalizeScanPath } from './gitleaks.js';
import { findTrufflehogMatch, runTrufflehogVerify } from './trufflehog.js';
import { redactSecret } from './redact.js';
import { isExcludedPath } from './exclusions.js';

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

function toCandidate(
  cwd: string,
  gl: GitleaksMatch,
  verifyStatus: VerifyStatus,
  detectorName?: string,
): SecretCandidate {
  const relPath = normalizeScanPath(cwd, gl.File);
  const redacted = redactSecret(gl.Secret || gl.Match);
  return {
    ruleId: gl.RuleID,
    description: gl.Description,
    path: relPath,
    lineStart: gl.StartLine,
    lineEnd: gl.EndLine || gl.StartLine,
    secretType: gl.RuleID,
    redactedValue: redacted,
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
      log: opts.log,
    });
  } catch (err) {
    const msg = String(err);
    log?.warn(`[secret-scan] gitleaks gate failed: ${msg}`);
    return {
      candidates: [],
      gitleaksCount: 0,
      gitleaksRawCount: 0,
      excludedCount: 0,
      trufflehogCount: 0,
      skippedReason: msg,
    };
  }

  const gitleaksRawCount = gitleaksMatches.length;
  gitleaksMatches = gitleaksMatches.filter((gl) => {
    const relPath = normalizeScanPath(opts.cwd, gl.File);
    return !isExcludedPath(relPath);
  });
  const excludedCount = gitleaksRawCount - gitleaksMatches.length;

  if (excludedCount > 0) {
    log?.info(`[secret-scan] path exclusions removed ${excludedCount} gitleaks hit(s)`);
  }

  if (gitleaksMatches.length === 0) {
    log?.info(
      `[secret-scan] gate complete — no candidates after gitleaks` +
        (gitleaksRawCount > 0 ? ` (${gitleaksRawCount} raw hit(s) excluded)` : ''),
    );
    return {
      candidates: [],
      gitleaksCount: 0,
      gitleaksRawCount,
      excludedCount,
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

  const candidates: SecretCandidate[] = gitleaksMatches.map((gl) => {
    const relPath = normalizeScanPath(opts.cwd, gl.File);
    const th = findTrufflehogMatch(trufflehogMatches, relPath, gl.StartLine);
    const status = verifyStatusFromTrufflehog(th);
    return toCandidate(opts.cwd, gl, status, th?.detectorName);
  });

  const verified = candidates.filter((c) => c.verifyStatus === 'verified').length;
  const dead = candidates.filter((c) => c.verifyStatus === 'dead').length;
  const unverified = candidates.filter((c) => c.verifyStatus === 'unverified').length;
  log?.info(
    `[secret-scan] gate complete — ${candidates.length} candidate(s): ` +
      `${verified} verified, ${dead} dead, ${unverified} unverified`,
  );

  return {
    candidates,
    gitleaksCount: gitleaksMatches.length,
    gitleaksRawCount,
    excludedCount,
    trufflehogCount: trufflehogMatches.length,
    trufflehogError,
  };
}

export type { SecretCandidate, SecretScanGateResult, SecretScanOptions, VerifyStatus };
