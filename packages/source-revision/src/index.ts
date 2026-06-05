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
  remote: RemoteRevision,
): boolean {
  if (!stored) return false;
  return stored === remote.revision;
}

export function formatRevisionComparison(
  stored: string | null | undefined,
  remote: RemoteRevision,
): string {
  const prev = stored ?? '(none)';
  return `${remote.kind} ${prev} → ${remote.revision} (${remote.label})`;
}

export type RevisionGateRepo = {
  status: string;
  packageType: string;
  url: string;
  packageName: string | null;
  packageVersion: string | null;
  lastScannedRevision: string | null;
};

export type RevisionGateResult =
  | { action: 'proceed'; log: string; remote?: RemoteRevision; lookupFailed?: boolean; lookupError?: string }
  | { action: 'skip'; reason: 'unchanged-revision'; log: string; message: string; remote: RemoteRevision };

const REVISION_SKIP_STATUSES = new Set(['done', 'skipped']);

/** Decide whether to skip a scan because upstream commit/version is unchanged. */
export async function evaluateRevisionGate(
  repo: RevisionGateRepo,
  options: RevisionLookupOptions & { force?: boolean } = {},
): Promise<RevisionGateResult> {
  const force = options.force ?? false;
  const target = revisionTargetFromRepo(repo);
  const lookupOptions: RevisionLookupOptions = { githubToken: options.githubToken };

  if (force) {
    return { action: 'proceed', log: `revision-gate: force enabled for ${repo.url}, proceeding` };
  }

  if (repo.status === 'failed') {
    return { action: 'proceed', log: `revision-gate: prior status failed for ${repo.url}, proceeding with re-scan` };
  }

  if (!repo.lastScannedRevision) {
    return {
      action: 'proceed',
      log: `revision-gate: no stored revision for ${repo.url} (status=${repo.status}), proceeding`,
    };
  }

  if (!REVISION_SKIP_STATUSES.has(repo.status)) {
    return {
      action: 'proceed',
      log: `revision-gate: status=${repo.status} for ${repo.url}, not eligible for unchanged skip`,
    };
  }

  const lookup = await resolveRemoteRevision(target, lookupOptions);
  if (!lookup.ok) {
    return {
      action: 'proceed',
      lookupFailed: true,
      lookupError: lookup.error,
      log: `revision-gate: remote lookup failed for ${repo.url} (${lookup.error}); proceeding (fail-open)`,
    };
  }

  const via = lookup.remote.source ?? 'unknown';
  const comparison = formatRevisionComparison(repo.lastScannedRevision, lookup.remote);
  if (isSameRevision(repo.lastScannedRevision, lookup.remote)) {
    return {
      action: 'skip',
      reason: 'unchanged-revision',
      remote: lookup.remote,
      message: `Skipped — unchanged ${lookup.remote.kind} (${lookup.remote.label})`,
      log: `revision-gate: SKIP unchanged content for ${repo.url} via ${via} — ${comparison}`,
    };
  }

  return {
    action: 'proceed',
    remote: lookup.remote,
    log: `revision-gate: content changed for ${repo.url} via ${via} — ${comparison}; proceeding`,
  };
}
