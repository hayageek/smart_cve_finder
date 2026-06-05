import {
  type PackageType,
  type RegistryPackageType,
  type ScanMode,
  REGISTRY_PACKAGE_TYPES,
  REGISTRY_PROVIDER,
} from '@secscan/shared';

export function detectGitProvider(url: string): string {
  if (url.includes('github.com')) return 'github';
  if (url.includes('bitbucket.org')) return 'bitbucket';
  if (url.includes('gitlab.com')) return 'gitlab';
  return 'other';
}

function isRegistryPackageType(value: string | undefined): value is RegistryPackageType {
  return REGISTRY_PACKAGE_TYPES.includes(value as RegistryPackageType);
}

export type ParsedEntry =
  | { packageType: 'git'; url: string; isPrivate: boolean }
  | { packageType: RegistryPackageType; url: string; packageName: string; packageVersion?: string };

/**
 * Canonical unique key (stored in Repo.url).
 * git → clone URL; registry packages → {type}:{name}[@version]
 */
export function buildRepoKey(type: PackageType, nameOrUrl: string, version?: string): string {
  if (type === 'git') return nameOrUrl;
  return version ? `${type}:${nameOrUrl}@${version}` : `${type}:${nameOrUrl}`;
}

export function registryProvider(type: RegistryPackageType): string {
  return REGISTRY_PROVIDER[type];
}

export function entryToCreateData(entry: ParsedEntry) {
  if (entry.packageType === 'git') {
    return {
      url: entry.url,
      packageType: 'git' as const,
      provider: detectGitProvider(entry.url),
      isPrivate: entry.isPrivate,
      status: 'queued',
    };
  }
  return {
    url: entry.url,
    packageType: entry.packageType,
    packageName: entry.packageName,
    packageVersion: entry.packageVersion ?? null,
    provider: registryProvider(entry.packageType),
    isPrivate: false,
    status: 'queued',
  };
}

export function entryToScanJobPayload(entry: ParsedEntry, scanJobId: string, scanMode: ScanMode = 'both') {
  if (entry.packageType === 'git') {
    return { repoUrl: entry.url, packageType: 'git' as const, scanJobId, scanMode };
  }
  return {
    repoUrl: entry.url,
    packageType: entry.packageType,
    packageName: entry.packageName,
    packageVersion: entry.packageVersion,
    scanJobId,
    scanMode,
  };
}

/** Parse a single CSV row (same rules as repo import). */
export function parseCsvRow(row: string[]): ParsedEntry | null {
  const col0 = row[0]?.trim();
  if (!col0) return null;

  if (col0.startsWith('http://') || col0.startsWith('https://')) {
    const visField = row.slice(1).find((v) =>
      ['public', 'private', 'internal'].includes(v.toLowerCase().trim()),
    );
    const isPrivate = visField
      ? ['private', 'internal'].includes(visField.toLowerCase().trim())
      : false;
    return { packageType: 'git', url: buildRepoKey('git', col0), isPrivate };
  }

  const pkgType = row[1]?.trim().toLowerCase();
  if (isRegistryPackageType(pkgType)) {
    const rawVersion = row[2]?.trim();
    const packageVersion = rawVersion && rawVersion.toLowerCase() !== 'latest' ? rawVersion : undefined;
    const url = buildRepoKey(pkgType, col0, packageVersion);
    return { packageType: pkgType, url, packageName: col0, packageVersion };
  }

  return null;
}

export type ScanTargetInput =
  | { gitUrl: string; isPrivate?: boolean }
  | { packageName: string; packageType: RegistryPackageType; packageVersion?: string };

export function scanTargetToEntry(input: ScanTargetInput): ParsedEntry | null {
  if ('gitUrl' in input) {
    const url = input.gitUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
    return { packageType: 'git', url: buildRepoKey('git', url), isPrivate: input.isPrivate ?? false };
  }

  const name = input.packageName.trim();
  if (!name) return null;
  const version = input.packageVersion?.trim();
  const packageVersion = version && version.toLowerCase() !== 'latest' ? version : undefined;
  const url = buildRepoKey(input.packageType, name, packageVersion);
  return {
    packageType: input.packageType,
    url,
    packageName: name,
    packageVersion,
  };
}

/** Convert a parsed CSV/import entry back to a manual scan target. */
export function parsedEntryToScanTarget(entry: ParsedEntry): ScanTargetInput {
  if (entry.packageType === 'git') {
    return { gitUrl: entry.url, isPrivate: entry.isPrivate };
  }
  return {
    packageName: entry.packageName,
    packageType: entry.packageType,
    packageVersion: entry.packageVersion,
  };
}
