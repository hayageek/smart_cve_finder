import { USER_AGENT } from '../config.js';
import { sleep } from '../rate-limit.js';
import type { FetchProgress, TopPackageRow } from '../types.js';

function cutoffMs(sinceHours: number): number {
  return Date.now() - sinceHours * 3_600_000;
}

interface RssItem {
  title: string;
  link: string;
  pubDate: string;
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim();
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim();
    if (title && link && pubDate) items.push({ title, link, pubDate });
  }

  return items;
}

function parsePyPiNameVersion(title: string): { name: string; version: string } {
  const space = title.lastIndexOf(' ');
  if (space === -1) return { name: title, version: '' };
  return { name: title.slice(0, space), version: title.slice(space + 1) };
}

function parsePackagistNameVersion(title: string): { name: string; version: string } {
  const match = title.match(/^(.+?)\s+\(v?([^)]+)\)$/);
  if (!match) return { name: title, version: '' };
  return { name: match[1], version: match[2] };
}

async function fetchRssRecent(
  url: string,
  sinceHours: number,
  maxResults: number | null,
  onProgress?: FetchProgress,
): Promise<RssItem[]> {
  onProgress?.(`GET ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status} for ${url}`);

  const xml = await res.text();
  const cutoff = cutoffMs(sinceHours);
  const recent: RssItem[] = [];

  for (const item of parseRssItems(xml)) {
    const publishedMs = Date.parse(item.pubDate);
    if (!Number.isFinite(publishedMs) || publishedMs < cutoff) break;
    recent.push(item);
    if (maxResults !== null && recent.length >= maxResults) break;
  }

  onProgress?.(
    `${recent.length} release(s) within ${sinceHours}h (cutoff ${new Date(cutoff).toISOString()})`,
  );

  return recent;
}

export async function fetchRecentPypi(
  sinceHours: number,
  maxResults: number | null,
  onProgress?: FetchProgress,
): Promise<TopPackageRow[]> {
  const items = await fetchRssRecent(
    'https://pypi.org/rss/updates.xml',
    sinceHours,
    maxResults,
    onProgress,
  );

  return items.map((item, i) => {
    const { name, version } = parsePyPiNameVersion(item.title);
    return {
      rank: i + 1,
      ecosystem: 'pypi' as const,
      name,
      version: version || null,
      publishedAt: new Date(item.pubDate).toISOString(),
      repoUrl: null,
      homepage: item.link,
      license: null,
      downloads: null,
      dependents: null,
      stars: null,
    };
  });
}

export async function fetchRecentPackagist(
  sinceHours: number,
  maxResults: number | null,
  onProgress?: FetchProgress,
): Promise<TopPackageRow[]> {
  const items = await fetchRssRecent(
    'https://packagist.org/feeds/releases.rss',
    sinceHours,
    maxResults,
    onProgress,
  );

  return items.map((item, i) => {
    const { name, version } = parsePackagistNameVersion(item.title);
    return {
      rank: i + 1,
      ecosystem: 'php' as const,
      name,
      version: version || null,
      publishedAt: new Date(item.pubDate).toISOString(),
      repoUrl: null,
      homepage: item.link,
      license: null,
      downloads: null,
      dependents: null,
      stars: null,
    };
  });
}

interface CargoCrate {
  name: string;
  newest_version?: string;
  created_at?: string;
  repository?: string | null;
  homepage?: string | null;
}

export async function fetchRecentCargo(
  sinceHours: number,
  maxResults: number | null,
  onProgress?: FetchProgress,
): Promise<TopPackageRow[]> {
  const cutoff = cutoffMs(sinceHours);
  const rows: TopPackageRow[] = [];
  const perPage = 100;

  onProgress?.(`cutoff ${new Date(cutoff).toISOString()} · ${perPage}/page`);

  for (let page = 1; ; page++) {
    const url = `https://crates.io/api/v1/crates?sort=new&per_page=${perPage}&page=${page}`;
    onProgress?.(`requesting page ${page}…`);
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`crates.io HTTP ${res.status}`);

    const body = (await res.json()) as { crates?: CargoCrate[] };
    const crates = body.crates ?? [];
    if (crates.length === 0) break;

    let reachedCutoff = false;

    for (const crate of crates) {
      const publishedMs = crate.created_at ? Date.parse(crate.created_at) : NaN;
      if (!Number.isFinite(publishedMs) || publishedMs < cutoff) {
        reachedCutoff = true;
        break;
      }

      rows.push({
        rank: rows.length + 1,
        ecosystem: 'rust',
        name: crate.name,
        version: crate.newest_version ?? null,
        publishedAt: crate.created_at ?? null,
        repoUrl: crate.repository ?? null,
        homepage: crate.homepage ?? null,
        license: null,
        downloads: null,
        dependents: null,
        stars: null,
      });

      if (maxResults !== null && rows.length >= maxResults) {
        onProgress?.(`reached limit ${maxResults}`);
        return rows;
      }
    }

    const oldest = crates[crates.length - 1]?.created_at ?? 'unknown';
    onProgress?.(`page ${page}: total ${rows.length}, oldest on page ${oldest}`);

    if (reachedCutoff) {
      onProgress?.(`passed ${sinceHours}h cutoff on page ${page}`);
      break;
    }
    if (crates.length < perPage) break;
    await sleep(300);
  }

  onProgress?.(`collected ${rows.length} crate(s)`);
  return rows;
}
