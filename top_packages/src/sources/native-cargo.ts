import { enrichConcurrency, USER_AGENT } from '../config.js';
import { mapPool } from '../rate-limit.js';
import type { TopPackageRow } from '../types.js';
import { normaliseRepoUrl } from '../normalize.js';
import type { FetchProgress } from '../types.js';

interface SummaryCrate {
  id: string;
  max_version?: string;
  description?: string;
  repository?: string;
  downloads?: number;
}

interface SummaryResponse {
  most_downloaded: SummaryCrate[];
}

export async function fetchTopCargo(
  limit: number,
  onProgress?: FetchProgress,
): Promise<TopPackageRow[]> {
  onProgress?.('crates.io: loading summary');
  const res = await fetch('https://crates.io/api/v1/summary', {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`crates.io summary HTTP ${res.status}`);

  const data = (await res.json()) as SummaryResponse;
  const slice = data.most_downloaded.slice(0, limit);

  const needsDetail = slice.filter((c) => !c.repository);
  onProgress?.(
    `crates.io: ${slice.length} crates (${needsDetail.length} need extra metadata, concurrency=${enrichConcurrency()})`,
  );

  const detailById = new Map<string, Awaited<ReturnType<typeof fetchCrateDetail>>>();
  if (needsDetail.length > 0) {
    const details = await mapPool(needsDetail, enrichConcurrency(), async (c) => {
      const detail = await fetchCrateDetail(c.id);
      return { id: c.id, detail };
    });
    for (const { id, detail } of details) detailById.set(id, detail);
  }

  return slice.map((c, i) => {
    const detail = detailById.get(c.id);
    return {
      rank: i + 1,
      ecosystem: 'rust' as const,
      name: c.id,
      version: detail?.version ?? c.max_version ?? null,
      repoUrl: normaliseRepoUrl(detail?.repository ?? c.repository),
      homepage: detail?.homepage ?? null,
      license: detail?.license ?? null,
      downloads: detail?.downloads ?? c.downloads ?? null,
      dependents: null,
      stars: null,
    };
  });
}

async function fetchCrateDetail(name: string): Promise<{
  version: string | null;
  repository: string | null;
  homepage: string | null;
  license: string | null;
  downloads: number | null;
}> {
  const res = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    return {
      version: null,
      repository: null,
      homepage: null,
      license: null,
      downloads: null,
    };
  }
  const data = (await res.json()) as {
    crate: {
      max_version?: string;
      repository?: string;
      homepage?: string;
      license?: string;
      downloads?: number;
    };
  };
  return {
    version: data.crate.max_version ?? null,
    repository: data.crate.repository ?? null,
    homepage: data.crate.homepage ?? null,
    license: data.crate.license ?? null,
    downloads: data.crate.downloads ?? null,
  };
}
