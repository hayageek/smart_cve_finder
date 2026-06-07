import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

export function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export function truncate(s: string, max = 60): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Last N characters of a vuln/finding UUID for compact table cells. */
export function formatVulnIdShort(id: string, tail = 5): string {
  return id.length <= tail ? id : id.slice(-tail);
}

export function pathBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/** File extension including the dot (e.g. `.json`), or null when absent. */
export function pathExtension(filePath: string): string | null {
  const base = pathBasename(filePath);
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  return base.slice(dot);
}

export function formatFileLine(
  path: string,
  lineStart: number,
  lineEnd?: number | null,
  maxLen = 100,
): string {
  const full = lineEnd != null ? `${path}:${lineStart}–${lineEnd}` : `${path}:${lineStart}`;
  return truncate(full, maxLen);
}

/** Table-friendly location: filename only (full path belongs in detail views). */
export function formatFileLineBasename(
  path: string,
  lineStart: number,
  lineEnd?: number | null,
): string {
  const file = pathBasename(path);
  return lineEnd != null ? `${file}:${lineStart}–${lineEnd}` : `${file}:${lineStart}`;
}

export function repoShortName(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\//, '').replace(/\.git$/, '');
  } catch {
    return url;
  }
}
