// ── Queue job payloads ───────────────────────────────────────────

export type PackageType = 'git' | 'npm' | 'pip' | 'cargo' | 'go' | 'gem';

/** Which scan pipelines to run for a job. */
export type ScanMode = 'both' | 'cve' | 'secrets';

/** CVE hunt skill chosen for a job. Overrides the worker CVE_SCAN_MODE default. */
export type CveHuntSkill = 'cve-ai-finder' | 'cve-variant-hunter' | 'sbom-vuln-mapper';

export type FindingOrigin =
  | 'cve-ai-finder'
  | 'cve-pattern-hunter'
  | 'cve-variant-hunter'
  | 'sbom-vuln-mapper';

/** Registry-backed package types (everything except git). */
export type RegistryPackageType = Exclude<PackageType, 'git'>;

export interface ScanJobData {
  /**
   * Canonical unique key (matches Repo.url):
   *   git   → clone URL
   *   npm   → npm:express[@ver]
   *   pip   → pip:requests[@ver]
   *   cargo → cargo:serde[@ver]
   *   go    → go:github.com/org/repo[@ver]
   *   gem   → gem:rails[@ver]
   */
  repoUrl: string;
  packageType: PackageType;
  /** Registry package name / Go module path (undefined for git) */
  packageName?: string;
  /** Requested version; undefined means latest (registry packages only) */
  packageVersion?: string;
  scanJobId: string;
  forceRescan?: boolean;
  /** Default: both — run CVE hunter and secret scan pipelines. */
  scanMode?: ScanMode;
  /**
   * CVE hunt skill for this job. Used when scanMode includes CVE.
   * Omitted → worker CVE_SCAN_MODE (ai-finder or semgrep-pattern-hunter).
   * Prefer cveSkills when more than one skill should run.
   */
  cveSkill?: CveHuntSkill;
  /** Skills to run for this job. When set, each skill runs and findings keep their own finding_origin. */
  cveSkills?: CveHuntSkill[];
}

export interface SourceAcquisitionInfo {
  packageType: PackageType;
  /** Clone URL (git), package name / module path (registry), or any target accepted by acquireSource */
  target: string;
  version?: string;
}

export interface ExploitJobData {
  vulnId: string;
  scanJobId: string;
  vulnJson: VulnerabilityFinding;
  /** Source acquisition parameters — exploit worker always re-downloads independently. */
  sourceAcquisition: SourceAcquisitionInfo;
}

// ── CVE Hunter output ────────────────────────────────────────────

export interface VulnerabilityFinding {
  check_id: string;
  finding_id: string;
  path: string;
  start: { line: number; col: number };
  end: { line: number; col: number };
  extra: {
    message: string;
    severity: Severity;
    metadata: {
      cwe: string;
      vulnerability_type: string;
      trust_boundary: string;
      requires_auth: string;
      requires_misconfig: boolean;
      source_location: string;
      sink_location: string;
      dataflow_steps: string[];
      confidence: string;
      confidence_reasons: string[];
      sink_strength: number;
      instances: unknown[];
      schema_version?: string;
      finding_origin?: FindingOrigin | string;
      variant?: VariantMetadata;
      sbom?: SbomMetadata;
    };
  };
}

export interface DroppedFinding {
  check_id: string;
  path: string;
  /** Flat form (legacy / normalized). */
  line?: number;
  line_end?: number;
  severity?: Severity;
  cwe?: string;
  vulnerability_type?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  /** Finding-shaped form (skill output) — same layout as VulnerabilityFinding. */
  start?: { line: number; col?: number };
  end?: { line: number; col?: number };
  extra?: {
    message?: string;
    severity?: Severity;
    metadata?: Record<string, unknown> & {
      cwe?: string;
      vulnerability_type?: string;
    };
  };
  drop_reason: string;
  drop_evidence: string;
}

/** cve-variant-hunter block on extra.metadata.variant */
export interface VariantMetadata {
  origin?: string;
  related_cves?: string[];
  fix_ref?: string;
  original_location?: string;
  bypass_rationale?: string;
  variant_sweep_signature?: string;
}

/** sbom-vuln-mapper block on extra.metadata.sbom */
export interface SbomMetadata {
  package?: string;
  version?: string;
  ecosystem?: string;
  upstream_cve?: string[];
  osv_id?: string;
  fixed_version?: string;
  cvss_score?: number;
  cvss_vector?: string;
  vulnerable_symbol?: string;
  dependency_kind?: string;
  dependency_path?: string[];
  introduced_by?: string;
  reachable?: boolean;
  reachability_evidence?: string;
  remediation?: string;
}

// ── Secret scan output ───────────────────────────────────────────

export type SecretVerifyStatus = 'verified' | 'unverified' | 'dead';

export interface SecretFinding {
  rule_id: string;
  finding_id: string;
  path: string;
  start: { line: number; col?: number };
  end: { line: number; col?: number };
  extra: {
    message: string;
    severity: Severity;
    metadata: {
      secret_type: string;
      redacted_value: string;
      verify_status: SecretVerifyStatus;
      detector_name?: string;
      description?: string;
      entropy?: number;
    };
  };
}

export interface DroppedSecretFinding {
  rule_id: string;
  path: string;
  start?: { line: number; col?: number };
  end?: { line: number; col?: number };
  extra?: {
    message?: string;
    severity?: Severity;
    metadata?: Record<string, unknown> & {
      secret_type?: string;
      redacted_value?: string;
      verify_status?: SecretVerifyStatus;
    };
  };
  drop_reason: string;
  drop_evidence: string;
}

// ── Domain enums ─────────────────────────────────────────────────

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type RepoStatus =
  | 'queued'
  | 'cloning'
  | 'scanning'
  | 'exploiting'
  | 'done'
  | 'failed'
  | 'skipped';

export type ScanStatus =
  | 'pending'
  | 'cloning'
  | 'scanning'
  | 'exploiting'
  | 'done'
  | 'failed'
  | 'skipped';

export type ExploitStatus = 'pending' | 'generating' | 'done' | 'failed';

export type WorkerType = 'scanner' | 'exploit';

// ── Socket.io events ─────────────────────────────────────────────

export interface DashboardStats {
  repos: { total: number; queued: number; scanning: number; done: number; failed: number };
  scans: { success: number; failed: number; avgDurationMs: number };
  vulns: { critical: number; high: number; medium: number; low: number; dropped: number; falsePositives: number };
  secrets: { critical: number; high: number; medium: number; low: number; dropped: number; falsePositives: number };
  exploits: { generated: number; pending: number; failed: number };
}

export interface QueueStats {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface ActivityEvent {
  id: string;
  timestamp: string;
  type: 'clone' | 'scan' | 'exploit' | 'error' | 'info';
  message: string;
  repoUrl?: string;
}

export interface LogLine {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  worker: 'scanner' | 'cve' | 'exploit' | 'api';
  message: string;
  jobId?: string;
}

export interface JobProgressEvent {
  jobId: string;
  scanJobId: string;
  repoUrl: string;
  stage: 'scan' | 'exploit-gen';
  progress: number;
  status: 'active' | 'completed' | 'failed';
  message?: string;
}

// ── API response shapes ───────────────────────────────────────────

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ApiRepo {
  id: string;
  /**
   * Canonical unique key:
   *   git  → clone URL        e.g.  https://github.com/org/repo
   *   npm   → npm:{name}[@v]
   *   pip   → pip:{name}[@v]
   *   cargo → cargo:{name}[@v]
   *   go    → go:{module}[@v]
   *   gem   → gem:{name}[@v]
   */
  url: string;
  /** Actual git repo URL discovered from registry metadata */
  repoUrl: string | null;
  packageName: string | null;
  packageType: PackageType;
  packageVersion: string | null;
  provider: string;
  isPrivate: boolean;
  status: RepoStatus;
  lastScannedAt: string | null;
  createdAt: string;
  vulnCount: number;
  secretCount: number;
  exploitCount: number;
}

export interface ApiScanJob {
  id: string;
  repoId: string;
  repoUrl: string;
  bullJobId: string | null;
  status: ScanStatus;
  stage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
  scanMode: ScanMode;
  /** CVE hunt skill recorded for this job, when the caller chose one. */
  cveSkill: string | null;
  vulnCount: number;
  secretCount: number;
  exploitCount: number;
}

export interface ApiSecretRuleCount {
  ruleId: string;
  count: number;
}

export interface ApiSecretRuleStats {
  confirmed: ApiSecretRuleCount[];
  dropped: ApiSecretRuleCount[];
}

export interface ApiSecret {
  id: string;
  scanJobId: string;
  repoUrl: string;
  packageRepoUrl: string | null;
  packageTarballUrl: string | null;
  ruleId: string;
  path: string;
  lineStart: number;
  lineEnd: number | null;
  severity: Severity;
  secretType: string | null;
  redactedValue: string | null;
  verifyStatus: SecretVerifyStatus;
  detectorName: string | null;
  message: string | null;
  metadataJson: Record<string, unknown> | null;
  isFalsePositive: boolean;
  dropped: boolean;
  dropReason: string | null;
  dropEvidence: string | null;
  createdAt: string;
  githubStars: number | null;
  githubForks: number | null;
  privateVulnerabilityReportingEnabled: boolean | null;
}

export interface ApiVulnerability {
  id: string;
  scanJobId: string;
  repoUrl: string;
  /** Discovered git repository URL from registry metadata (null for git repos or when not available) */
  packageRepoUrl: string | null;
  /** Package archive download URL from registry (null for git repos or when not available) */
  packageTarballUrl: string | null;
  checkId: string;
  path: string;
  lineStart: number;
  lineEnd: number | null;
  severity: Severity;
  cwe: string;
  vulnType: string | null;
  message: string | null;
  metadataJson: Record<string, unknown> | null;
  isFalsePositive: boolean;
  /** Reported/disclosed as CVE (workflow complete). */
  cveReported: boolean;
  cveReportedAt: string | null;
  cvssScore: number | null;
  // dropped findings live in the same table; dropped=false means confirmed
  dropped: boolean;
  dropReason: string | null;
  dropEvidence: string | null;
  // exploit lifecycle fields — null until an exploit run is triggered
  exploitStatus: ExploitStatus | null;
  reportPath: string | null;
  exploitPath: string | null;
  payloadPath: string | null;
  exploitError: string | null;
  exploitAttempts: number | null;
  /** Filenames under REPORTS_DIR/{id}/ when an exploit run has been attempted. */
  artifactFiles: string[];
  createdAt: string;
  /** GitHub stargazers (from linked repo; null if unknown or non-GitHub). */
  githubStars: number | null;
  githubForks: number | null;
  /** Private vulnerability reporting ("Report a vulnerability") on the linked GitHub repo. */
  privateVulnerabilityReportingEnabled: boolean | null;
}

export interface ApiExploitResult {
  id: string;
  vulnId: string;
  repoUrl: string;
  cwe: string;
  path: string;
  severity: Severity;
  dropped: boolean;
  status: ExploitStatus;
  reportPath: string | null;
  exploitPath: string | null;
  payloadPath: string | null;
  error: string | null;
  attempts: number | null;
  artifactFiles: string[];
  createdAt: string;
}

export interface WorkerConfig {
  id: string;
  scannerConcurrency: number;
  exploitConcurrency: number;
  /** When false, findings are saved after a scan but NOT auto-queued for exploitation. */
  autoQueueExploits: boolean;
  exploitMinSeverity: Severity;
  exploitIncludeDropped: boolean;
  dedupWindowHours: number;
  workspaceCleanupHours: number;
  notifyWebhookUrl: string | null;
  notifyOnCritical: boolean;
  notifyOnScanComplete: boolean;
  /** cursor | claude. Null on older rows means the worker uses AGENT_RUNNER from the environment. */
  agentRunner: 'cursor' | 'claude' | null;
  /** Model id for the Claude runner (for example openai/glm-5.2). */
  claudeAgentModel: string | null;
  /** OpenAI-compatible proxy URL. Empty string means do not send ANTHROPIC_BASE_URL. */
  anthropicBaseUrl: string | null;
  /** Claude API key. Empty string means do not send ANTHROPIC_API_KEY. */
  anthropicApiKey: string | null;
  cursorAgentModel: string | null;
  cursorApiKey: string | null;
  cursorAgentTimeoutMs: number | null;
  debugAgent: boolean | null;
  claudeMaxTokens: number | null;
  claudeAgentMaxTurns: number | null;
}

/** GET /api/workers/config — effective agent settings + env inheritance hints. */
export interface WorkerConfigView extends WorkerConfig {
  anthropicApiKeyConfigured?: boolean;
  anthropicApiKeyFromEnv?: boolean;
  claudeAgentModelFromEnv?: boolean;
  agentRunnerFromEnv?: boolean;
  anthropicBaseUrlFromEnv?: boolean;
  cursorAgentModelFromEnv?: boolean;
  cursorApiKeyConfigured?: boolean;
  cursorApiKeyFromEnv?: boolean;
  cursorAgentTimeoutMsFromEnv?: boolean;
  debugAgentFromEnv?: boolean;
  claudeMaxTokensFromEnv?: boolean;
  claudeAgentMaxTurnsFromEnv?: boolean;
}
