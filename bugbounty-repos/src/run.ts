import { clearAllOrgCache, clearOrgCache, readOrgCache, writeOrgCache } from './cache.js';
import { loadPrograms, packageRoot } from './config.js';
import { searchActiveRepos, validateToken } from './github.js';
import { buildOrgTasks } from './orgs-data.js';
import { repoToRow, writeCsv } from './output.js';
import { ProgressTracker } from './progress.js';
import type { CliOptions, OrgCacheEntry, RepoRow } from './types.js';

function cutoffDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function run(options: CliOptions): Promise<void> {
  const programsFile = loadPrograms(options.programsPath);
  const cutoff = cutoffDate(options.days);

  console.error(`Active cutoff: pushed after ${cutoff}`);
  console.error(`Programs file: ${options.programsPath}`);
  console.error(`Cache dir:     ${options.cacheDir}`);

  const tokenStatus = await validateToken();
  if (tokenStatus.ok) {
    console.error(`GitHub: ${tokenStatus.message}`);
    if (tokenStatus.rateLimit) {
      const { remaining, limit, resetAt } = tokenStatus.rateLimit;
      console.error(`Search API quota: ${remaining}/${limit} remaining (resets ${resetAt} UTC)`);
    }
  } else {
    console.error(`GitHub: ${tokenStatus.message}`);
  }
  console.error('');

  if (options.force) {
    const removed = clearAllOrgCache(options.cacheDir);
    console.error(`--force: cleared ${removed} cached org file(s)`);
  }

  for (const org of options.forceOrgs) {
    if (clearOrgCache(options.cacheDir, org)) {
      console.error(`--force-org: cleared cache for ${org}`);
    }
  }

  console.error('Programs:');
  const tasks = buildOrgTasks(programsFile.programs);

  if (tasks.length === 0) {
    throw new Error('No GitHub orgs resolved — check programs.yml');
  }

  console.error(`\nProcessing ${tasks.length} org(s) across ${programsFile.programs.length} program(s) …\n`);

  const progress = new ProgressTracker(tasks.length);
  const seenUrls = new Set<string>();
  const rows: RepoRow[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const { program, org } = tasks[i];
    const stepStart = Date.now();

    const mustRefetch = options.force || options.forceOrgs.has(org);
    let cacheEntry: OrgCacheEntry | null = null;

    if (!mustRefetch) {
      cacheEntry = readOrgCache(options.cacheDir, org, cutoff);
    }

    if (cacheEntry) {
      progress.begin({ index: i + 1, program, org, source: 'cache' });
      progress.tick({
        index: i + 1,
        program,
        org,
        source: 'cache',
        repoCount: cacheEntry.repos.length,
        elapsedMs: Date.now() - stepStart,
        truncated: cacheEntry.truncated,
      });
    } else {
      progress.begin({ index: i + 1, program, org, source: 'fetch' });
      const fetchResult = await searchActiveRepos(org, cutoff, (p) => {
        if (p.total > 100) {
          console.error(`  ${org}: fetched page ${p.page} (${p.fetched}/${p.total} repos) …`);
        }
      });
      cacheEntry = {
        org,
        fetchedAt: new Date().toISOString(),
        cutoffDate: cutoff,
        totalCount: fetchResult.totalCount,
        truncated: fetchResult.truncated,
        repos: fetchResult.repos,
        skipped: fetchResult.skipped,
        skipReason: fetchResult.skipReason,
      };
      writeOrgCache(options.cacheDir, cacheEntry);

      progress.tick({
        index: i + 1,
        program,
        org,
        source: fetchResult.skipped ? 'skip' : 'fetch',
        repoCount: fetchResult.repos.length,
        elapsedMs: Date.now() - stepStart,
        truncated: fetchResult.truncated,
        skipReason: fetchResult.skipReason,
      });
    }

    for (const repo of cacheEntry.repos) {
      if (!repo.clone_url || seenUrls.has(repo.clone_url)) continue;
      seenUrls.add(repo.clone_url);
      rows.push(repoToRow(program, org, repo));
    }
  }

  rows.sort((a, b) => {
    const byProgram = a.program.localeCompare(b.program);
    if (byProgram !== 0) return byProgram;
    const byOrg = a.org.localeCompare(b.org, undefined, { sensitivity: 'base' });
    if (byOrg !== 0) return byOrg;
    return a.repo_name.localeCompare(b.repo_name);
  });

  writeCsv(options.outputPath, rows);
  progress.summary(options.outputPath, rows.length);
}

export function defaultOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  const root = packageRoot();
  return {
    programsPath: `${root}/programs.yml`,
    outputPath: `${root}/../bugbounty-active-repos.csv`,
    cacheDir: `${root}/.cache/orgs`,
    days: 365,
    force: false,
    forceOrgs: new Set(),
    verbose: false,
    ...overrides,
  };
}
