import type { PackageType, RegistryPackageType } from '@secscan/shared';

export type RevisionKind = 'git-commit' | 'package-version';

export interface RemoteRevision {
  revision: string;
  kind: RevisionKind;
  /** Human-readable label for logs (short SHA or semver). */
  label: string;
  /** How the revision was resolved (for logs). */
  source?: 'github-api' | 'git-ls-remote' | 'registry';
}

export type RevisionLookupOptions = {
  /** GitHub PAT — enables REST API for github.com URLs (higher rate limits). */
  githubToken?: string;
};

export type RevisionTarget =
  | { packageType: 'git'; url: string }
  | { packageType: RegistryPackageType; packageName: string; packageVersion?: string };

export type RevisionLookupResult =
  | { ok: true; remote: RemoteRevision }
  | { ok: false; error: string };

export function revisionTargetFromRepo(repo: {
  packageType: string;
  url: string;
  packageName: string | null;
  packageVersion: string | null;
}): RevisionTarget {
  if (repo.packageType === 'git') {
    return { packageType: 'git', url: repo.url };
  }
  return {
    packageType: repo.packageType as RegistryPackageType,
    packageName: repo.packageName ?? repo.url.split(':')[1]?.split('@')[0] ?? repo.url,
    packageVersion: repo.packageVersion ?? undefined,
  };
}

export function revisionTargetFromPackageType(
  packageType: PackageType,
  repoUrl: string,
  packageName?: string,
  packageVersion?: string,
): RevisionTarget {
  if (packageType === 'git') {
    return { packageType: 'git', url: repoUrl };
  }
  return {
    packageType,
    packageName: packageName ?? repoUrl.split(':')[1]?.split('@')[0] ?? repoUrl,
    packageVersion,
  };
}
