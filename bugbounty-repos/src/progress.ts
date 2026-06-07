export class ProgressTracker {
  private readonly startedAt = Date.now();
  private completed = 0;
  private totalRepos = 0;
  private cacheHits = 0;
  private fetches = 0;
  private skips = 0;

  constructor(private readonly totalOrgs: number) {}

  begin(opts: { index: number; program: string; org: string; source: 'cache' | 'fetch' }): void {
    const line = [
      `[${opts.index}/${this.totalOrgs}]`,
      `${opts.program} → ${opts.org}`,
      opts.source === 'fetch' ? 'FETCHING…' : 'CACHE',
    ].join('  ');
    console.error(line);
  }

  tick(opts: {
    index: number;
    program: string;
    org: string;
    source: 'cache' | 'fetch' | 'skip';
    repoCount: number;
    elapsedMs: number;
    truncated?: boolean;
    skipReason?: string;
  }): void {
    this.completed += 1;
    this.totalRepos += opts.repoCount;
    if (opts.source === 'cache') this.cacheHits += 1;
    else if (opts.source === 'skip') this.skips += 1;
    else this.fetches += 1;

    const elapsed = Date.now() - this.startedAt;
    const avgMs = elapsed / this.completed;
    const remaining = this.totalOrgs - this.completed;
    const etaMs = remaining * avgMs;
    const trunc = opts.truncated ? ' (truncated at 1000)' : '';
    const skip = opts.skipReason ? ` (${opts.skipReason})` : '';

    const line = [
      `[${opts.index}/${this.totalOrgs}]`,
      `${opts.program} → ${opts.org}`,
      opts.source.toUpperCase().padEnd(5),
      `${opts.repoCount} repos${trunc}${skip}`,
      `step ${(opts.elapsedMs / 1000).toFixed(1)}s`,
      `ETA ${formatDuration(etaMs)}`,
      `total ${this.totalRepos} repos`,
      `(cache ${this.cacheHits}, fetch ${this.fetches}, skip ${this.skips})`,
    ].join('  ');

    console.error(line);
  }

  summary(outputPath: string, rowCount: number): void {
    const elapsed = Date.now() - this.startedAt;
    console.error('');
    console.error('── Summary ──────────────────────────────────────');
    console.error(`  Orgs processed : ${this.completed}/${this.totalOrgs}`);
    console.error(`  Cache hits     : ${this.cacheHits}`);
    console.error(`  API fetches    : ${this.fetches}`);
    console.error(`  Skipped orgs   : ${this.skips}`);
    console.error(`  Unique repos   : ${rowCount}`);
    console.error(`  Elapsed        : ${formatDuration(elapsed)}`);
    console.error(`  Output         : ${outputPath}`);
    console.error('─────────────────────────────────────────────────');
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min}m ${rem}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}
