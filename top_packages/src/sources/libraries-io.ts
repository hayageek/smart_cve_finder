import { librariesIoKey } from '../config.js';
import { librariesIoFetch } from '../libraries-io-client.js';
import type { EcosystemId, TopPackageRow } from '../types.js';
import { normaliseRepoUrl } from '../normalize.js';

const PLATFORM: Record<EcosystemId, string> = {
  npm: 'NPM',
  pypi: 'Pypi',
  maven: 'Maven',
  go: 'Go',
  php: 'Packagist',
  ruby: 'Rubygems',
  rust: 'Cargo',
};

/**
 * libraries.io search times out (~60s → 502) when per_page is too large for NPM.
 * Empty/missing `q` also triggers slow paths. Use q="" and small pages.
 */
const SAFE_PER_PAGE = 30;

interface LibrariesIoHit {
  name: string;
  platform: string;
  description?: string;
  homepage?: string;
  repository_url?: string;
  latest_release_number?: string;
  licenses?: string;
  normalized_licenses?: string[];
  dependents_count?: number;
  stars?: number;
}

export type LibrariesIoProgress = (message: string) => void;

async function fetchSearchPage(
  platform: string,
  apiKey: string,
  page: number,
  perPage: number,
  onProgress?: LibrariesIoProgress,
): Promise<LibrariesIoHit[]> {
  const url = new URL('https://libraries.io/api/search');
  url.searchParams.set('q', '');
  url.searchParams.set('platforms', platform);
  url.searchParams.set('sort', 'dependents_count');
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('api_key', apiKey);

  onProgress?.(`${platform} page ${page} (per_page=${perPage})`);

  let res = await librariesIoFetch(url, {
    onWait: (ms, reason) => onProgress?.(`waiting ${ms}ms (${reason})`),
  });

  // Last resort: smaller page if the server still returns 502.
  if (res.status === 502 && perPage > 10) {
    const smaller = Math.max(10, Math.floor(perPage / 2));
    onProgress?.(`${platform} HTTP 502 — retrying page ${page} with per_page=${smaller}`);
    url.searchParams.set('per_page', String(smaller));
    res = await librariesIoFetch(url, {
      onWait: (ms, reason) => onProgress?.(`waiting ${ms}ms (${reason})`),
    });
    if (res.ok) {
      return (await res.json()) as LibrariesIoHit[];
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`libraries.io ${platform} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  return (await res.json()) as LibrariesIoHit[];
}

export async function fetchTopFromLibrariesIo(
  ecosystem: EcosystemId,
  limit: number,
  onProgress?: LibrariesIoProgress,
): Promise<TopPackageRow[]> {
  const apiKey = librariesIoKey();
  if (!apiKey) {
    throw new Error(
      'LIBRARIES_IO_KEY is required for libraries.io (set it in top_packages/.env)',
    );
  }

  const platform = PLATFORM[ecosystem];
  const hits: LibrariesIoHit[] = [];

  for (let page = 1; hits.length < limit; page++) {
    const remaining = limit - hits.length;
    const perPage = Math.min(SAFE_PER_PAGE, remaining);

    const pageHits = await fetchSearchPage(platform, apiKey, page, perPage, onProgress);
    if (pageHits.length === 0) break;
    hits.push(...pageHits);
    if (pageHits.length < perPage) break;
  }

  return hits.slice(0, limit).map((hit, i) => ({
    rank: i + 1,
    ecosystem,
    name: hit.name,
    version: hit.latest_release_number ?? null,
    repoUrl: normaliseRepoUrl(hit.repository_url),
    homepage: hit.homepage ?? null,
    license: hit.normalized_licenses?.[0] ?? hit.licenses ?? null,
    downloads: null,
    dependents: hit.dependents_count ?? null,
    stars: hit.stars ?? null,
  }));
}
