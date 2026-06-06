import type { ScanMode } from '@secscan/shared';
import type { RevisionLookupOptions, RevisionLookupResult, RevisionTarget, RemoteRevision } from './types.js';
import { revisionTargetFromRepo } from './types.js';
import { resolveGitRemoteRevision } from './git.js';
import { resolveRegistryRevision } from './registry.js';

export type {
  RemoteRevision,
  RevisionKind,
  RevisionLookupOptions,
  RevisionLookupResult,
  RevisionTarget,
} from './types.js';
export {
  revisionTargetFromRepo,
  revisionTargetFromPackageType,
} from './types.js';

/** Lightweight remote lookup — no clone/download. */
export async function resolveRemoteRevision(
  target: RevisionTarget,
  options: RevisionLookupOptions = {},
): Promise<RevisionLookupResult> {
  if (target.packageType === 'git') {
    return resolveGitRemoteRevision(target.url, options);
  }
  const result = await resolveRegistryRevision(target.packageType, target.packageName, target.packageVersion);
  if (result.ok) {
    return { ok: true, remote: { ...result.remote, source: 'registry' } };
  }
  return result;
}

export function isSameRevision(
  stored: string | null | undefined,
  remote: RemoteRevision | string,
): boolean {
  if (!stored) return false;
  const revision = typeof remote === 'string' ? remote : remote.revision;
  return stored === revision;
}

export function formatRevisionComparison(
  stored: string | null | undefined,
  remote: RemoteRevision,
): string {
  const prev = stored ?? '(none)';
  return `${remote.kind} ${prev} → ${remote.revision} (${remote.label})`;
}

export type StoredPipelineRevisions = {
  cve: string | null;
  secrets: string | null;
};

export type RevisionGateRepo = {
  status: string;
  packageType: string;
  url: string;
  packageName: string | null;
  packageVersion: string | null;
  lastCveScannedRevision?: string | null;
  lastSecretScannedRevision?: string | null;
  /** Legacy single-field revision — used only when per-pipeline fields are unset. */
  lastScannedRevision?: string | null;
};

export type PipelineRunPlan = {
  runCve: boolean;
  runSecrets: boolean;
};

export type RevisionGateResult =
  | {
      action: 'proceed';
      log: string;
      pipelines: PipelineRunPlan;
      remote?: RemoteRevision;
      lookupFailed?: boolean;
      lookupError?: string;
    }
  | { action: 'skip'; reason: 'unchanged-revision'; log: string; message: string; remote: RemoteRevision };

const REVISION_SKIP_STATUSES = new Set(['done', 'skipped']);

/** Per-pipeline stored revisions (null = that pipeline has never completed at any revision). */
export function storedRevisionsFromRepo(repo: RevisionGateRepo): StoredPipelineRevisions {
  const legacy = repo.lastScannedRevision ?? null;
  return {
    cve: repo.lastCveScannedRevision ?? legacy,
    secrets: repo.lastSecretScannedRevision ?? null,
  };
}

function pipelinesRequested(scanMode: ScanMode): PipelineRunPlan {
  return {
    runCve: scanMode === 'both' || scanMode === 'cve',
    runSecrets: scanMode === 'both' || scanMode === 'secrets',
  };
}

/** Decide which pipelines still need scanning at the given revision. */
export function resolvePipelinesToRun(
  scanMode: ScanMode,
  stored: StoredPipelineRevisions,
  revision: RemoteRevision | string,
  force = false,
): PipelineRunPlan & { allDone: boolean } {
  const requested = pipelinesRequested(scanMode);
  if (force) {
    return { ...requested, allDone: false };
  }

  const runCve = requested.runCve && !isSameRevision(stored.cve, revision);
  const runSecrets = requested.runSecrets && !isSameRevision(stored.secrets, revision);
  return { runCve, runSecrets, allDone: !runCve && !runSecrets };
}

function formatPipelineSkipMessage(
  scanMode: ScanMode,
  remote: RemoteRevision,
  stored: StoredPipelineRevisions,
): string {
  const requested = pipelinesRequested(scanMode);
  const parts: string[] = [];
  if (requested.runCve && isSameRevision(stored.cve, remote)) {
    parts.push('CVE');
  }
  if (requested.runSecrets && isSameRevision(stored.secrets, remote)) {
    parts.push('secrets');
  }
  const skipped = parts.length ? parts.join(' + ') : 'all requested pipelines';
  return `Skipped — ${skipped} already scanned at unchanged ${remote.kind} (${remote.label})`;
}

/** Decide whether to skip enqueue/clone because upstream revision is unchanged for all requested pipelines. */
export async function evaluateRevisionGate(
  repo: RevisionGateRepo,
  options: RevisionLookupOptions & { force?: boolean; scanMode?: ScanMode } = {},
): Promise<RevisionGateResult> {
  const force = options.force ?? false;
  const scanMode = options.scanMode ?? 'both';
  const requested = pipelinesRequested(scanMode);
  const target = revisionTargetFromRepo(repo);
  const lookupOptions: RevisionLookupOptions = { githubToken: options.githubToken };

  if (force) {
    return {
      action: 'proceed',
      pipelines: requested,
      log: `revision-gate: force enabled for ${repo.url}, proceeding (${scanMode})`,
    };
  }

  if (repo.status === 'failed') {
    return {
      action: 'proceed',
      pipelines: requested,
      log: `revision-gate: prior status failed for ${repo.url}, proceeding with re-scan (${scanMode})`,
    };
  }

  const stored = storedRevisionsFromRepo(repo);
  const hasAnyStored = stored.cve !== null || stored.secrets !== null;

  if (!hasAnyStored) {
    return {
      action: 'proceed',
      pipelines: requested,
      log: `revision-gate: no stored pipeline revisions for ${repo.url} (status=${repo.status}), proceeding (${scanMode})`,
    };
  }

  if (!REVISION_SKIP_STATUSES.has(repo.status)) {
    return {
      action: 'proceed',
      pipelines: requested,
      log: `revision-gate: status=${repo.status} for ${repo.url}, not eligible for unchanged skip (${scanMode})`,
    };
  }

  const lookup = await resolveRemoteRevision(target, lookupOptions);
  if (!lookup.ok) {
    return {
      action: 'proceed',
      pipelines: requested,
      lookupFailed: true,
      lookupError: lookup.error,
      log: `revision-gate: remote lookup failed for ${repo.url} (${lookup.error}); proceeding (fail-open)`,
    };
  }

  const via = lookup.remote.source ?? 'unknown';
  const plan = resolvePipelinesToRun(scanMode, stored, lookup.remote, false);

  if (plan.allDone) {
    const cveCmp = formatRevisionComparison(stored.cve, lookup.remote);
    const secretCmp = formatRevisionComparison(stored.secrets, lookup.remote);
    return {
      action: 'skip',
      reason: 'unchanged-revision',
      remote: lookup.remote,
      message: formatPipelineSkipMessage(scanMode, lookup.remote, stored),
      log: `revision-gate: SKIP all requested pipelines for ${repo.url} via ${via} (${scanMode}) — cve: ${cveCmp}; secrets: ${secretCmp}`,
    };
  }

  const skipped: string[] = [];
  if (requested.runCve && !plan.runCve) skipped.push('CVE');
  if (requested.runSecrets && !plan.runSecrets) skipped.push('secrets');
  const skipNote = skipped.length ? `; skipping unchanged: ${skipped.join(', ')}` : '';

  return {
    action: 'proceed',
    pipelines: { runCve: plan.runCve, runSecrets: plan.runSecrets },
    remote: lookup.remote,
    log: `revision-gate: partial proceed for ${repo.url} via ${via} (${scanMode})${skipNote}`,
  };
}
