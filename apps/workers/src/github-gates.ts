import type { PrismaClient } from '@prisma/client';
import {
  fetchGitHubRepoSnapshot,
  githubUrlFromRepo,
  isRepoInactiveByPushedAt,
  type GitHubRepoSnapshot,
} from '@secscan/shared';
import type { RegistryPackageType } from '@secscan/shared';
import { config } from './config.js';
import type { createWorkerLogger } from './logger.js';
import { resolveRegistryPackage } from './pipeline.js';

type JobLog = ReturnType<typeof createWorkerLogger>;

export type GitHubGateSkip = {
  skip: true;
  reason: string;
  message: string;
};

export type GitHubGateContinue = {
  skip: false;
  snapshot: GitHubRepoSnapshot | null;
  githubUrl: string | null;
};

export type GitHubGateResult = GitHubGateSkip | GitHubGateContinue;

const REGISTRY_TYPES = new Set<RegistryPackageType>(['npm', 'pip', 'cargo', 'go', 'gem']);

/**
 * Resolve a GitHub URL for scan gates: direct git/go keys, cached repoUrl, or registry metadata.
 */
async function resolveGitHubUrlForScan(
  repo: {
    url: string;
    repoUrl: string | null;
    packageType: string;
    packageName: string | null;
    packageVersion: string | null;
  },
  jobLog: JobLog,
): Promise<string | null> {
  const direct = githubUrlFromRepo(repo);
  if (direct) return direct;

  if (repo.packageType === 'git' || !repo.packageName || !REGISTRY_TYPES.has(repo.packageType as RegistryPackageType)) {
    return null;
  }

  try {
    jobLog.info(
      { packageType: repo.packageType, packageName: repo.packageName },
      'Resolving registry metadata for GitHub stars/PVR',
    );
    const meta = await resolveRegistryPackage(
      repo.packageType as RegistryPackageType,
      repo.packageName,
      repo.packageVersion ?? undefined,
    );
    const ghUrl = meta.repoUrl ? githubUrlFromRepo({ url: '', repoUrl: meta.repoUrl }) : null;
    if (ghUrl) {
      jobLog.info({ githubUrl: ghUrl, resolvedVersion: meta.resolvedVersion }, 'Discovered GitHub repo from registry');
    } else if (meta.repoUrl) {
      jobLog.debug({ repository: meta.repoUrl }, 'Registry repository is not on GitHub — skipping stars/PVR');
    } else {
      jobLog.debug('No repository URL in registry metadata');
    }
    return ghUrl;
  } catch (err: unknown) {
    jobLog.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Registry resolve for GitHub metadata failed — proceeding without stars/PVR gates',
    );
    return null;
  }
}

/**
 * For GitHub repos (including registry packages whose upstream is on GitHub): fetch stars/forks/PVR,
 * persist on Repo, and apply SCAN_MIN_STARS / SCAN_MAX_INACTIVE_YEARS / SCAN_REQUIRE_PVR.
 * When SCAN_MIN_STARS > 0, scans are skipped if stars are below the threshold or unknown
 * (e.g. invalid/missing GITHUB_TOKEN).
 * When SCAN_MAX_INACTIVE_YEARS > 0, scans are skipped if the last GitHub push is older than
 * that window (no commits in the last N years).
 */
export async function applyGitHubScanGates(
  prisma: PrismaClient,
  repoUrl: string,
  jobLog: JobLog,
): Promise<GitHubGateResult> {
  const repo = await prisma.repo.findUnique({ where: { url: repoUrl } });
  if (!repo) {
    return { skip: false, snapshot: null, githubUrl: null };
  }

  const ghUrl = await resolveGitHubUrlForScan(repo, jobLog);
  if (!ghUrl) {
    return { skip: false, snapshot: null, githubUrl: null };
  }

  // Persist discovered GitHub URL early so UI/API show stars/PVR for packages too
  if (repo.repoUrl !== ghUrl) {
    await prisma.repo.update({
      where: { url: repoUrl },
      data: { repoUrl: ghUrl },
    });
  }

  const token = config.GITHUB_TOKEN;
  const snapshot = await fetchGitHubRepoSnapshot(ghUrl, token);

  await prisma.repo.update({
    where: { url: repoUrl },
    data: {
      githubStars: snapshot.githubStars,
      githubForks: snapshot.githubForks,
      privateVulnerabilityReportingEnabled: snapshot.privateVulnerabilityReportingEnabled,
    },
  });

  const parts: string[] = [];
  if (snapshot.githubStars != null) {
    parts.push(`${snapshot.githubStars} stars, ${snapshot.githubForks ?? 0} forks`);
  }
  if (snapshot.privateVulnerabilityReportingEnabled != null) {
    parts.push(
      `private vulnerability reporting ${snapshot.privateVulnerabilityReportingEnabled ? 'on' : 'off'}`,
    );
  }
  if (parts.length) {
    jobLog.info({ ghUrl, ...snapshot }, `GitHub metadata: ${parts.join('; ')}`);
  }

  const minStars = config.SCAN_MIN_STARS;
  const maxInactiveYears = config.SCAN_MAX_INACTIVE_YEARS;
  const requirePvr = config.SCAN_REQUIRE_PVR;
  const starCount = snapshot.githubStars;

  if (maxInactiveYears > 0) {
    const inactive = isRepoInactiveByPushedAt(snapshot.pushedAt, maxInactiveYears);
    if (inactive === true) {
      const lastPush = snapshot.pushedAt ?? 'unknown';
      const message =
        `Repository has had no commits in the last ${maxInactiveYears} years (last push: ${lastPush}) — skipping scan`;
      jobLog.info({ ghUrl, pushedAt: snapshot.pushedAt, maxInactiveYears }, message);
      return { skip: true, reason: 'inactive-repo', message };
    }
    if (inactive === null) {
      jobLog.warn(
        { ghUrl, maxInactiveYears },
        'Could not determine last push date — proceeding with scan (fail-open)',
      );
    }
  }

  if (minStars > 0) {
    if (starCount === null) {
      const message =
        `Could not determine GitHub star count (check GITHUB_TOKEN / API access) — skipping scan (SCAN_MIN_STARS=${minStars})`;
      jobLog.warn({ ghUrl, minStars }, message);
      return { skip: true, reason: 'stars-unknown', message };
    }
    if (starCount < minStars) {
      const message = `Repository has ${starCount} stars (minimum ${minStars}) - skipping scan`;
      jobLog.info({ ghUrl, starCount, minStars }, message);
      return { skip: true, reason: 'below-min-stars', message };
    }
  }

  if (
    requirePvr &&
    snapshot.privateVulnerabilityReportingEnabled === false
  ) {
    const message =
      'Private vulnerability reporting is not enabled for this repository - skipping scan';
    jobLog.info({ ghUrl }, message);
    return { skip: true, reason: 'pvr-disabled', message };
  }

  if (requirePvr && snapshot.privateVulnerabilityReportingEnabled === null) {
    jobLog.warn(
      { ghUrl },
      'SCAN_REQUIRE_PVR=true but PVR status unknown — proceeding with scan',
    );
  }

  return { skip: false, snapshot, githubUrl: ghUrl };
}
