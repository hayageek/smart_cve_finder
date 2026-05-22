// ── Queue job payloads ───────────────────────────────────────────

export type PackageType = 'git' | 'npm' | 'pip' | 'cargo' | 'go' | 'gem';

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
    };
  };
}

export interface DroppedFinding {
  check_id: string;
  path: string;
  line: number;
  line_end?: number;
  severity?: Severity;
  cwe: string;
  vulnerability_type?: string;
  message?: string;
  metadata?: Record<string, unknown>;
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
  vulnCount: number;
  exploitCount: number;
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
  createdAt: string;
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
}
