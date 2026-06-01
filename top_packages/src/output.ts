import type { TopPackageRow } from './types.js';

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(rows: TopPackageRow[], urlsOnly: boolean): string {
  if (urlsOnly) {
    const urls = rows.map((r) => r.repoUrl).filter((u): u is string => Boolean(u));
    return `${urls.join('\n')}\n`;
  }

  const header =
    'rank,ecosystem,name,version,repo_url,homepage,license,downloads,dependents,stars';
  const lines = rows.map((r) =>
    [
      r.rank,
      r.ecosystem,
      r.name,
      r.version ?? '',
      r.repoUrl ?? '',
      r.homepage ?? '',
      r.license ?? '',
      r.downloads ?? '',
      r.dependents ?? '',
      r.stars ?? '',
    ]
      .map((v) => csvEscape(String(v)))
      .join(','),
  );
  return `${[header, ...lines].join('\n')}\n`;
}

export function toJson(rows: TopPackageRow[]): string {
  return `${JSON.stringify(rows, null, 2)}\n`;
}
