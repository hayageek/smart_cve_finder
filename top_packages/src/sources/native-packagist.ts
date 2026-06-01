import { enrichConcurrency, USER_AGENT } from '../config.js';
import { mapPool } from '../rate-limit.js';
import type { TopPackageRow } from '../types.js';
import { normaliseRepoUrl } from '../normalize.js';
import type { FetchProgress } from '../types.js';

interface PopularResponse {
  packages: Array<{
    name: string;
    description?: string;
    url: string;
    downloads: number;
    favers: number;
  }>;
  next?: string;
}

export async function fetchTopPackagist(
  limit: number,
  onProgress?: FetchProgress,
): Promise<TopPackageRow[]> {
  const packages: PopularResponse['packages'] = [];
  let url: string | null =
    `https://packagist.org/explore/popular.json?per_page=${Math.min(100, limit)}`;

  onProgress?.('Packagist: loading popular packages');
  while (url && packages.length < limit) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`Packagist popular HTTP ${res.status}`);
    const data = (await res.json()) as PopularResponse;
    packages.push(...data.packages);
    url = packages.length < limit && data.next ? data.next : null;
  }

  const slice = packages.slice(0, limit);
  onProgress?.(`Packagist: enriching ${slice.length} packages (concurrency=${enrichConcurrency()})`);

  return mapPool(slice, enrichConcurrency(), async (pkg, i) => {
    const detail = await fetchPackagistDetail(pkg.name);
    return {
      rank: i + 1,
      ecosystem: 'php' as const,
      name: pkg.name,
      version: detail.version,
      repoUrl: detail.repoUrl,
      homepage: detail.homepage,
      license: detail.license,
      downloads: pkg.downloads,
      dependents: null,
      stars: pkg.favers,
    };
  });
}

async function fetchPackagistDetail(name: string): Promise<{
  version: string | null;
  repoUrl: string | null;
  homepage: string | null;
  license: string | null;
}> {
  const res = await fetch(`https://packagist.org/packages/${name}.json`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    return { version: null, repoUrl: null, homepage: null, license: null };
  }
  const data = (await res.json()) as {
    package: {
      repository?: string;
      versions?: Record<string, { version?: string; license?: string | string[] }>;
    };
  };
  const versions = data.package.versions ?? {};
  const latestKey = Object.keys(versions)
    .filter((v) => v !== 'dev-master' && !v.startsWith('dev-'))
    .sort()
    .at(-1);
  const latest = latestKey ? versions[latestKey] : undefined;
  const license = latest?.license;
  return {
    version: latest?.version ?? latestKey ?? null,
    repoUrl: normaliseRepoUrl(data.package.repository),
    homepage: null,
    license: Array.isArray(license) ? license[0] : license ?? null,
  };
}
