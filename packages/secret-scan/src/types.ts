import type { Severity } from '@secscan/shared';

export type VerifyStatus = 'verified' | 'unverified' | 'dead';

export interface GitleaksMatch {
  RuleID: string;
  Description: string;
  File: string;
  StartLine: number;
  EndLine: number;
  StartColumn?: number;
  EndColumn?: number;
  Match: string;
  Secret: string;
  Entropy?: number;
  Tags?: string[];
}

export interface TrufflehogMatch {
  file: string;
  line: number;
  detectorName: string;
  verified: boolean;
  raw?: string;
  redacted?: string;
}

export interface SecretCandidate {
  ruleId: string;
  description: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  secretType: string;
  redactedValue: string;
  entropy?: number;
  verifyStatus: VerifyStatus;
  detectorName?: string;
  severity: Severity;
}

export interface SecretScanOptions {
  cwd: string;
  gitleaksBin?: string;
  trufflehogBin?: string;
  configPath?: string;
  /** When false, skip git history and scan filesystem only (default for packages). */
  noGit?: boolean;
  /** Drop candidates below this severity (e.g. MEDIUM excludes LOW). Default: no filter. */
  minSeverity?: Severity;
  /** When true, mask secret values in stored findings (default: store full value). */
  redactSecrets?: boolean;
  log?: SecretScanLogger;
}

export interface SecretScanLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface SecretScanGateResult {
  candidates: SecretCandidate[];
  /** Gitleaks hits after path exclusions. */
  gitleaksCount: number;
  /** Gitleaks hits before path exclusions. */
  gitleaksRawCount: number;
  excludedCount: number;
  /** Gitleaks hits removed because the value contained JSON/config brackets. */
  malformedFilteredCount?: number;
  trufflehogCount: number;
  trufflehogError?: string;
  /** Candidates removed because severity was below minSeverity. */
  severityFilteredCount?: number;
  skippedReason?: string;
}
