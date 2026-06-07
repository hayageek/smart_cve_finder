import { USER_AGENT, githubToken } from './config.js';
import type { GitHubRepo, OrgFetchResult } from './types.js';

const GITHUB_API = 'https://api.github.com';
const SEARCH_DELAY_MS = 7_000;
const AUTH_SEARCH_DELAY_MS = 1_000;

let token: string | undefined = githubToken();
let tokenChecked = false;
let authenticated = false;

interface SearchResponse {
  total_count: number;
  items: GitHubRepo[];
}

export interface TokenStatus {
  ok: boolean;
  login?: string;
  message: string;
  rateLimit?: { remaining: number; limit: number; resetAt: string };
}

function authHeaders(useToken: boolean): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (useToken && token) h.Authorization = `Bearer ${token}`;
  return h;
}

function log(msg: string): void {
  console.error(msg);
}

async function sleepWithCountdown(label: string, totalMs: number): Promise<void> {
  const stepMs = 5_000;
  let remaining = totalMs;
  while (remaining > 0) {
    const wait = Math.min(stepMs, remaining);
    await new Promise((r) => setTimeout(r, wait));
    remaining -= wait;
    if (remaining > 0) {
      log(`  ${label} … ${Math.ceil(remaining / 1000)}s left`);
    }
  }
}

async function waitForSearchQuota(useToken: boolean): Promise<void> {
  const response = await fetch(`${GITHUB_API}/rate_limit`, { headers: authHeaders(useToken) });
  if (!response.ok) return;

  const data = (await response.json()) as {
    resources?: { search?: { remaining: number; reset: number } };
  };
  const search = data.resources?.search;
  if (!search || search.remaining > 0) return;

  const waitSec = Math.max(search.reset - Math.floor(Date.now() / 1000) + 2, 30);
  const resetAt = new Date(search.reset * 1000).toISOString().replace('T', ' ').slice(0, 19);
  log(`  Search quota exhausted; waiting until ${resetAt} UTC (${waitSec}s) …`);
  await sleepWithCountdown('  waiting for search quota', waitSec * 1000);
}

export async function validateToken(): Promise<TokenStatus> {
  const raw = githubToken();
  if (!raw) {
    return {
      ok: false,
      message: 'No GITHUB_TOKEN set. Add one to .env — unauthenticated search is limited to ~10 req/min.',
    };
  }

  const response = await fetch(`${GITHUB_API}/user`, { headers: authHeaders(true) });
  const body = (await response.json().catch(() => ({}))) as {
    message?: string;
    login?: string;
  };

  if (response.status === 401) {
    token = undefined;
    authenticated = false;
    tokenChecked = true;
    const hint = raw.startsWith('github_pat_')
      ? 'Fine-grained PAT rejected — it may be expired or revoked. Create a new one at https://github.com/settings/tokens?type=beta (Public repositories: Read).'
      : 'Token rejected — it may be expired or revoked. Create a new classic PAT at https://github.com/settings/tokens (public_repo scope).';
    return { ok: false, message: `GITHUB_TOKEN invalid (401 Bad credentials). ${hint}` };
  }

  if (!response.ok) {
    token = undefined;
    authenticated = false;
    tokenChecked = true;
    return { ok: false, message: `GITHUB_TOKEN check failed (HTTP ${response.status}): ${body.message ?? 'unknown'}` };
  }

  const rate = await fetch(`${GITHUB_API}/rate_limit`, { headers: authHeaders(true) });
  const rateBody = (await rate.json().catch(() => ({}))) as {
    resources?: { search?: { remaining: number; limit: number; reset: number } };
  };
  const search = rateBody.resources?.search;
  const resetAt = search?.reset
    ? new Date(search.reset * 1000).toISOString().replace('T', ' ').slice(0, 19)
    : '?';

  token = raw;
  authenticated = true;
  tokenChecked = true;

  return {
    ok: true,
    login: body.login,
    message: `Authenticated as ${body.login}`,
    rateLimit: search
      ? { remaining: search.remaining, limit: search.limit, resetAt }
      : undefined,
  };
}

async function githubFetch(url: string, useToken: boolean, isSearch = false): Promise<Response> {
  while (true) {
    if (isSearch) await waitForSearchQuota(useToken);

    const response = await fetch(url, { headers: authHeaders(useToken) });

    if (response.status === 403) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      const msg = (body.message ?? '').toLowerCase();
      if (msg.includes('rate limit') || msg.includes('abuse') || msg.includes('secondary')) {
        const reset = Number(response.headers.get('x-ratelimit-reset') ?? '0');
        const waitSec = Math.max(reset - Math.floor(Date.now() / 1000) + 2, isSearch ? 30 : 60);
        const resetAt = reset ? new Date(reset * 1000).toISOString().replace('T', ' ').slice(0, 19) : '?';
        log(`  Rate limited (${useToken ? 'auth' : 'unauth'}); resuming ~${resetAt} UTC (${waitSec}s) …`);
        await sleepWithCountdown('  waiting for rate limit', waitSec * 1000);
        continue;
      }
    }

    if ([502, 503, 504].includes(response.status)) {
      log(`  HTTP ${response.status}; retrying in 10s …`);
      await sleepWithCountdown('  retrying', 10_000);
      continue;
    }

    return response;
  }
}

async function searchPages(
  org: string,
  cutoffDate: string,
  useToken: boolean,
  onPage?: (info: { page: number; fetched: number; total: number }) => void,
): Promise<OrgFetchResult | { error: number; body: string }> {
  const repos: GitHubRepo[] = [];
  let page = 1;
  let totalCount = 0;
  let truncated = false;
  const query = `org:${org} pushed:>${cutoffDate}`;

  while (true) {
    const params = new URLSearchParams({
      q: query,
      sort: 'updated',
      order: 'desc',
      per_page: '100',
      page: String(page),
    });
    const url = `${GITHUB_API}/search/repositories?${params.toString()}`;
    const response = await githubFetch(url, useToken, true);

    if (!response.ok) {
      const body = await response.text();
      return { error: response.status, body };
    }

    const data = (await response.json()) as SearchResponse;
    totalCount = data.total_count ?? 0;
    const items = data.items ?? [];
    repos.push(...items);

    onPage?.({ page, fetched: repos.length, total: totalCount });

    if (repos.length >= totalCount || items.length < 100) break;
    if (page >= 10) {
      truncated = true;
      break;
    }

    page += 1;
    const delay = useToken ? AUTH_SEARCH_DELAY_MS : SEARCH_DELAY_MS;
    if (delay > 0) {
      log(`  ${org}: page ${page}/${Math.min(Math.ceil(totalCount / 100), 10)} (waiting ${delay / 1000}s) …`);
      await sleepWithCountdown('  waiting between pages', delay);
    }
  }

  return { repos, totalCount, truncated };
}

export async function searchActiveRepos(
  org: string,
  cutoffDate: string,
  onPage?: (info: { page: number; fetched: number; total: number }) => void,
): Promise<OrgFetchResult> {
  if (!tokenChecked) {
    tokenChecked = true;
    if (!token) log('No GITHUB_TOKEN — unauthenticated search (~10 req/min).');
  }

  const useTokenFirst = Boolean(token);
  let result = await searchPages(org, cutoffDate, useTokenFirst, onPage);

  if ('error' in result && result.error === 422 && useTokenFirst) {
    log(`  ${org}: search blocked for token (HTTP 422) — retrying without auth …`);
    result = await searchPages(org, cutoffDate, false, onPage);
  }

  if ('error' in result) {
    const { error, body } = result;
    if (error === 404 || error === 422) {
      const reason =
        error === 422
          ? 'org not searchable (missing, private, or token lacks access)'
          : 'org not found';
      log(`  ${org}: SKIP — ${reason}`);
      return { repos: [], totalCount: 0, truncated: false, skipped: true, skipReason: reason };
    }
    throw new Error(`Search failed for ${org} (HTTP ${error}): ${body.slice(0, 200)}`);
  }

  return result;
}
