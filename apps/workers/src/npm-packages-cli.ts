#!/usr/bin/env node
/**
 * npm-packages-cli — fetch Atlassian npm packages and emit CSV.
 *
 * Discovery sources (paginated, deduplicated):
 *   - npm search for "atlassian" via registry.npmjs.org (same index as npm.com/search)
 *   - https://www.npmjs.com/org/atlassian?page=N          (Playwright)
 *   - https://www.npmjs.com/org/atlassianlabs?page=N      (Playwright)
 *   - https://www.npmjs.com/~atlassianartifactteam?page=N (Playwright)
 *
 * Pass --browser-search to crawl npm.com/search pages with Playwright instead of
 * registry search (slower; often blocked by Cloudflare on later pages).
 *
 * Keeps packages whose scope is @atlassian, @atlassianlabs, @atlaskit, or
 * @atlassian-dc-mcp, or whose repository org is atlassian / atlassianlabs.
 *
 * Usage:
 *   npm run npm-packages
 *   npm run npm-packages -- --output atlassian-npm.csv
 *   npm run npm-packages -- --verbose --browser-search
 */

import { writeFile } from 'fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { normaliseRepoUrl } from './pipeline.js';

const ALLOWED_SCOPES = ['@atlassian', '@atlassianlabs', '@atlaskit', '@atlassian-dc-mcp'] as const;
const ALLOWED_REPO_ORGS = new Set(['atlassian', 'atlassianlabs']);

const SEARCH_URL = (page: number) =>
  `https://www.npmjs.com/search?q=atlassian&page=${page}&perPage=20`;

const BROWSER_SOURCES = [
  { label: 'org/atlassian', url: (page: number) => `https://www.npmjs.com/org/atlassian?page=${page}` },
  { label: 'org/atlassianlabs', url: (page: number) => `https://www.npmjs.com/org/atlassianlabs?page=${page}` },
  {
    label: 'user/atlassianartifactteam',
    url: (page: number) => `https://www.npmjs.com/~atlassianartifactteam?page=${page}`,
  },
] as const;

interface PackageRow {
  name: string;
  version: string;
  repoUrl: string;
  lastPublished: string;
}

interface RegistryDoc {
  'dist-tags'?: { latest?: string };
  time?: Record<string, string>;
  repository?: { url?: string } | string;
}

// ── Arg parsing ───────────────────────────────────────────────────

const argv = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

const outputPath = getFlag('--output');
const verbose = argv.includes('--verbose') || argv.includes('-v');
const headed = argv.includes('--headed');
const browserSearch = argv.includes('--browser-search');
const pageDelayMs = Number(getFlag('--delay') ?? '1500');
const maxRetries = Number(getFlag('--retries') ?? '3');

function log(...args: unknown[]) {
  if (verbose) console.error('[npm-packages]', ...args);
}

// ── Filters ─────────────────────────────────────────────────────

function hasAllowedNamespace(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_SCOPES.some((scope) => lower.startsWith(`${scope}/`));
}

function repoOrgFromUrl(repoUrl: string | null): string | null {
  if (!repoUrl) return null;
  const normalised = repoUrl
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');
  const match = normalised.match(/(?:github|gitlab|bitbucket)\.(?:com|org)[/:]([^/]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function hasAllowedRepoOrg(repoUrl: string | null): boolean {
  const org = repoOrgFromUrl(repoUrl);
  return org !== null && ALLOWED_REPO_ORGS.has(org);
}

function matchesFilter(name: string, repoUrl: string | null): boolean {
  return hasAllowedNamespace(name) || hasAllowedRepoOrg(repoUrl);
}

// ── Crawling ──────────────────────────────────────────────────────

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPackageLinks(page: Page, timeoutMs = 45_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = await extractPackageNames(page);
    if (names.length > 0) return names;

    const title = await page.title();
    if (title.includes('Just a moment')) {
      await sleep(1000);
      continue;
    }
    await sleep(500);
  }
  return [];
}

async function extractPackageNames(page: Page): Promise<string[]> {
  return page.locator('a[href^="/package/"]').evaluateAll((els) =>
    [
      ...new Set(
        els.map((el) => {
          const href = (el as { getAttribute(name: string): string | null }).getAttribute('href') ?? '';
          const path = href.replace(/^\/package\//, '').split('#')[0];
          return decodeURIComponent(path);
        }),
      ),
    ].filter(Boolean),
  );
}

type ListingResult =
  | { status: 'ok'; names: string[] }
  | { status: 'empty' }
  | { status: 'failed' };

async function loadListingPage(page: Page, url: string): Promise<ListingResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      if (response && response.status() === 403) {
        log(`403 on ${url}, attempt ${attempt}/${maxRetries}`);
        await sleep(3000 * attempt);
        continue;
      }
      const names = await waitForPackageLinks(page);
      if (names.length > 0) return { status: 'ok', names };

      const title = await page.title();
      if (!title.includes('Just a moment') && response?.ok()) {
        return { status: 'empty' };
      }
      log(`Challenge or empty on ${url}, attempt ${attempt}/${maxRetries}`);
    } catch (err) {
      log(`Error loading ${url}, attempt ${attempt}/${maxRetries}:`, (err as Error).message);
    }
    await sleep(3000 * attempt);
  }
  return { status: 'failed' };
}

async function crawlBrowserSource(
  page: Page,
  label: string,
  urlForPage: (page: number) => string,
): Promise<string[]> {
  const discovered: string[] = [];
  let pageNum = 0;

  while (true) {
    const url = urlForPage(pageNum);
    log(`Crawling ${label} page ${pageNum}: ${url}`);

    let result: ListingResult | null = null;
    for (let round = 0; round < maxRetries; round++) {
      result = await loadListingPage(page, url);
      if (result.status !== 'failed') break;
      log(`Retrying ${label} page ${pageNum} (round ${round + 2}/${maxRetries})`);
      await sleep(5000 * (round + 1));
    }

    if (!result || result.status === 'failed') {
      console.error(`Warning: giving up on ${label} page ${pageNum} after repeated failures`);
      break;
    }
    if (result.status === 'empty') break;

    discovered.push(...result.names);
    log(`  found ${result.names.length} packages (${discovered.length} total from ${label})`);
    pageNum++;
    await sleep(pageDelayMs);
  }

  return discovered;
}

async function discoverFromRegistrySearch(query: string): Promise<string[]> {
  const names: string[] = [];
  const pageSize = 250;
  let from = 0;

  console.error(`Searching registry.npmjs.org for "${query}"…`);
  while (true) {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${pageSize}&from=${from}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      log(`Registry search failed at from=${from}: HTTP ${res.status}`);
      break;
    }
    const body = (await res.json()) as { objects?: Array<{ package?: { name?: string } }> };
    const batch = (body.objects ?? [])
      .map((obj) => obj.package?.name)
      .filter((name): name is string => Boolean(name));
    if (batch.length === 0) break;
    names.push(...batch);
    log(`Registry search from=${from}: ${batch.length} packages (${names.length} total)`);
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return names;
}

function shouldFetchRegistry(name: string, fromBrowser: boolean): boolean {
  if (hasAllowedNamespace(name)) return true;
  if (fromBrowser) return true;
  const lower = name.toLowerCase();
  return lower.includes('atlassian') || lower.includes('atlaskit');
}

async function discoverPackageNames(browser: Browser): Promise<Map<string, boolean>> {
  /** package name -> whether it came from a browser org/user page */
  const byName = new Map<string, boolean>();

  const add = (names: string[], fromBrowser: boolean) => {
    for (const name of names) {
      if (!byName.has(name)) byName.set(name, fromBrowser);
      else if (fromBrowser) byName.set(name, true);
    }
  };

  if (browserSearch) {
    console.error('Crawling npm.com search with Playwright…');
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    const searchNames = await crawlBrowserSource(page, 'search', SEARCH_URL);
    add(searchNames, false);
    await context.close();

    if (searchNames.length < 100) {
      console.error('Browser search incomplete; supplementing with registry search…');
      add(await discoverFromRegistrySearch('atlassian'), false);
    }
  } else {
    add(await discoverFromRegistrySearch('atlassian'), false);
  }

  console.error('Crawling npm.com org/user pages with Playwright…');
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  for (const source of BROWSER_SOURCES) {
    add(await crawlBrowserSource(page, source.label, source.url), true);
    await sleep(pageDelayMs);
  }

  await context.close();
  return byName;
}

// ── Registry metadata ─────────────────────────────────────────────

function repositoryUrl(doc: RegistryDoc): string | null {
  const repo = doc.repository;
  if (!repo) return null;
  if (typeof repo === 'string') return normaliseRepoUrl(repo);
  return normaliseRepoUrl(repo.url);
}

async function fetchRegistryMeta(name: string): Promise<PackageRow | null> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    log(`Registry miss for ${name}: HTTP ${res.status}`);
    return null;
  }

  const doc = (await res.json()) as RegistryDoc;
  const version = doc['dist-tags']?.latest;
  if (!version) return null;

  const lastPublished = doc.time?.[version] ?? '';
  const repoUrl = repositoryUrl(doc) ?? '';

  return { name, version, repoUrl, lastPublished };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// ── CSV ───────────────────────────────────────────────────────────

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function toCsv(rows: PackageRow[]): string {
  const header = 'package name,version,repo URL,last published';
  const lines = rows.map((row) =>
    [row.name, row.version, row.repoUrl, row.lastPublished].map(csvEscape).join(','),
  );
  return [header, ...lines].join('\n') + '\n';
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`npm-packages — fetch Atlassian npm packages as CSV

Options:
  --output <file>     Write CSV to file (default: stdout)
  --verbose, -v       Log crawl progress to stderr
  --browser-search    Crawl npm.com/search with Playwright (default: registry search)
  --headed            Run browser with UI (default: headless)
  --delay <ms>        Pause between page loads (default: 1500)
  --retries <n>       Retries per listing page (default: 3)
`);
    return;
  }

  const browser = await chromium.launch({ headless: !headed });

  try {
    const discovered = await discoverPackageNames(browser);
    console.error(`Discovered ${discovered.size} unique package names.`);

    const toFetch = [...discovered.entries()].filter(([name, fromBrowser]) =>
      shouldFetchRegistry(name, fromBrowser),
    );
    console.error(`Fetching metadata for ${toFetch.length} candidate packages…`);

    const metas = await mapWithConcurrency(toFetch, 8, async ([name]) => fetchRegistryMeta(name));
    const resolved = metas.filter((row): row is PackageRow => row !== null);

    const filtered = resolved
      .filter((row) => matchesFilter(row.name, row.repoUrl || null))
      .sort((a, b) => {
        const ta = Date.parse(a.lastPublished) || 0;
        const tb = Date.parse(b.lastPublished) || 0;
        return tb - ta;
      });

    console.error(`Matched ${filtered.length} packages after namespace/repo-org filter.`);

    const csv = toCsv(filtered);
    if (outputPath) {
      await writeFile(outputPath, csv, 'utf-8');
      console.error(`Wrote ${filtered.length} rows to ${outputPath}`);
    } else {
      process.stdout.write(csv);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('npm-packages failed:', err);
  process.exit(1);
});
