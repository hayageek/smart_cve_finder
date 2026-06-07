import { librariesIoKey } from '../config.js';
import { librariesIoFetch, librariesIoMinInterval } from '../libraries-io-client.js';
import { normaliseRepoUrl } from '../normalize.js';
import type { EcosystemId, TopPackageRow } from '../types.js';
import type { LibrariesIoProgress } from './libraries-io.js';

const PLATFORM: Record<EcosystemId, string> = {
  npm: 'NPM',
  pypi: 'Pypi',
  maven: 'Maven',
  go: 'Go',
  php: 'Packagist',
  ruby: 'Rubygems',
  rust: 'Cargo',
};

const PER_PAGE = 30;

interface LibrariesIoRecentHit {
  name: string;
  platform: string;
  description?: string;
  homepage?: string;
  repository_url?: string;
  latest_release_number?: string;
  latest_release_published_at?: string;
  licenses?: string;
  normalized_licenses?: string[];
  dependents_count?: number;
  stars?: number;
}

function parsePublishedAt(value?: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function fetchRecentPage(
  platform: string,
  apiKey: string,
  page: number,
  onProgress?: LibrariesIoProgress,
): Promise<LibrariesIoRecentHit[]> {
  const url = new URL('https://libraries.io/api/search');
  url.searchParams.set('q', '');
  url.searchParams.set('platforms', platform);
  url.searchParams.set('sort', 'latest_release_published_at');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('api_key', apiKey);

  const pageStart = Date.now();
  onProgress?.(`requesting page ${page}…`);

  const res = await librariesIoFetch(url, {
    onWait: (ms, reason) =>
      onProgress?.(`rate-limit wait ${formatElapsed(ms)} (${reason})`),
  });

  const requestMs = Date.now() - pageStart;

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`libraries.io ${platform} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const hits = (await res.json()) as LibrariesIoRecentHit[];
  onProgress?.(`page ${page} fetched in ${formatElapsed(requestMs)} (${hits.length} rows)`);
  return hits;
}

function toRow(hit: LibrariesIoRecentHit, ecosystem: EcosystemId, rank: number): TopPackageRow {
  return {
    rank,
    ecosystem,
    name: hit.name,
    version: hit.latest_release_number ?? null,
    publishedAt: hit.latest_release_published_at ?? null,
    repoUrl: normaliseRepoUrl(hit.repository_url),
    homepage: hit.homepage ?? null,
    license: hit.normalized_licenses?.[0] ?? hit.licenses ?? null,
    downloads: null,
    dependents: hit.dependents_count ?? null,
    stars: hit.stars ?? null,
  };
}

export async function fetchRecentFromLibrariesIo(
  ecosystem: EcosystemId,
  sinceHours: number,
  maxResults: number | null,
  onProgress?: LibrariesIoProgress,
): Promise<TopPackageRow[]> {
  const apiKey = librariesIoKey();
  if (!apiKey) {
    throw new Error(
      'LIBRARIES_IO_KEY is required for --recent (set it in top_packages/.env)',
    );
  }

  const platform = PLATFORM[ecosystem];
  const cutoffMs = Date.now() - sinceHours * 3_600_000;
  const rows: TopPackageRow[] = [];
  const startedAt = Date.now();
  let pagesFetched = 0;

  onProgress?.(
    `cutoff ${new Date(cutoffMs).toISOString()} · ${PER_PAGE}/page · ~${librariesIoMinInterval()}ms between requests`,
  );

  for (let page = 1; ; page++) {
    pagesFetched = page;
    const hits = await fetchRecentPage(platform, apiKey, page, onProgress);
    if (hits.length === 0) {
      onProgress?.(`page ${page} empty — done`);
      break;
    }

    let reachedCutoff = false;
    let added = 0;

    for (const hit of hits) {
      const publishedMs = parsePublishedAt(hit.latest_release_published_at);
      if (publishedMs !== null && publishedMs < cutoffMs) {
        reachedCutoff = true;
        break;
      }

      rows.push(toRow(hit, ecosystem, rows.length + 1));
      added++;
      if (maxResults !== null && rows.length >= maxResults) {
        onProgress?.(
          `reached limit ${maxResults} after ${page} page(s), ${formatElapsed(Date.now() - startedAt)} elapsed`,
        );
        return rows;
      }
    }

    const oldest = hits[hits.length - 1]?.latest_release_published_at ?? 'unknown';
    onProgress?.(
      `page ${page}: +${added} in window (total ${rows.length}), oldest on page ${oldest}, ${formatElapsed(Date.now() - startedAt)} elapsed`,
    );

    if (reachedCutoff) {
      onProgress?.(`passed ${sinceHours}h cutoff on page ${page} — done`);
      break;
    }
    if (hits.length < PER_PAGE) {
      onProgress?.(`last page (${hits.length} rows) — done`);
      break;
    }
  }

  onProgress?.(
    `collected ${rows.length} package(s) in ${pagesFetched} page(s), ${formatElapsed(Date.now() - startedAt)} total`,
  );

  return rows;
}
