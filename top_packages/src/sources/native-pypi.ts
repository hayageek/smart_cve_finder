import { enrichConcurrency, USER_AGENT } from '../config.js';
import { mapPool } from '../rate-limit.js';
import type { TopPackageRow } from '../types.js';
import { normaliseRepoUrl } from '../normalize.js';
import type { FetchProgress } from '../types.js';

const PYPI_TOP_URL = 'https://hugovk.dev/top-pypi-packages/top-pypi-packages.min.json';

interface PypiTopJson {
  rows: Array<{ project: string; download_count: number }>;
}

export async function fetchTopPypi(
  limit: number,
  onProgress?: FetchProgress,
): Promise<TopPackageRow[]> {
  onProgress?.('PyPI: loading download rankings');
  const res = await fetch(PYPI_TOP_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`PyPI top list HTTP ${res.status}`);

  const data = (await res.json()) as PypiTopJson;
  const slice = data.rows.slice(0, limit);

  onProgress?.(`PyPI: enriching ${slice.length} packages (concurrency=${enrichConcurrency()})`);

  const enriched = await mapPool(slice, enrichConcurrency(), async (row, i) => {
    const meta = await fetchPypiMeta(row.project);
    return {
      rank: i + 1,
      ecosystem: 'pypi' as const,
      name: row.project,
      version: meta.version,
      repoUrl: meta.repoUrl,
      homepage: meta.homepage,
      license: meta.license,
      downloads: row.download_count,
      dependents: null,
      stars: null,
    };
  });

  return enriched;
}

async function fetchPypiMeta(name: string): Promise<{
  version: string | null;
  repoUrl: string | null;
  homepage: string | null;
  license: string | null;
}> {
  const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    return { version: null, repoUrl: null, homepage: null, license: null };
  }
  const meta = (await res.json()) as {
    info: {
      version: string;
      license?: string;
      home_page?: string;
      project_urls?: Record<string, string>;
    };
  };
  const urls = meta.info.project_urls ?? {};
  const repoUrl = normaliseRepoUrl(
    urls['Source'] ?? urls['Repository'] ?? urls['Homepage'] ?? meta.info.home_page,
  );
  return {
    version: meta.info.version ?? null,
    repoUrl,
    homepage: meta.info.home_page ?? urls['Homepage'] ?? null,
    license: meta.info.license ?? null,
  };
}
