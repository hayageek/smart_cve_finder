import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { OrgCacheEntry } from './types.js';

export function ensureCacheDir(cacheDir: string): void {
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
}

function cachePath(cacheDir: string, org: string): string {
  return join(cacheDir, `${org}.json`);
}

export function readOrgCache(
  cacheDir: string,
  org: string,
  cutoffDate: string,
): OrgCacheEntry | null {
  const path = cachePath(cacheDir, org);
  if (!existsSync(path)) return null;

  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as OrgCacheEntry;
    if (entry.cutoffDate !== cutoffDate || entry.org !== org) return null;
    return entry;
  } catch {
    return null;
  }
}

export function writeOrgCache(cacheDir: string, entry: OrgCacheEntry): void {
  ensureCacheDir(cacheDir);
  const path = cachePath(cacheDir, entry.org);
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
}

export function clearOrgCache(cacheDir: string, org: string): boolean {
  const path = cachePath(cacheDir, org);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

export function clearAllOrgCache(cacheDir: string): number {
  if (!existsSync(cacheDir)) return 0;
  let removed = 0;
  for (const name of readdirSync(cacheDir)) {
    if (!name.endsWith('.json')) continue;
    rmSync(join(cacheDir, name));
    removed += 1;
  }
  return removed;
}
