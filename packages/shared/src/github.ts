const GITHUB_REST_ACCEPT = 'application/vnd.github+json';
const GITHUB_API_VERSION = '2026-03-10';

/** Result of GET /repos/{owner}/{repo}/private-vulnerability-reporting */
export type PrivateVulnerabilityReportingResult =
  | { ok: true; enabled: boolean }
  | {
      ok: false;
      code: 'not_github' | 'parse_error' | 'not_found' | 'http_error' | 'network';
      message?: string;
      httpStatus?: number;
    };

export interface GitHubRepoMetadata {
  stars: number;
  forks: number;
  openIssues: number;
  language?: string;
  archived?: boolean;
  isFork?: boolean;
  pushedAt?: string;
  description?: string;
}

export function parseGitHubUrl(repoUrl: string): { owner: string; repo: string } | null {
  const match = repoUrl.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/** Normalize git/go/npm-style strings to an https://github.com/owner/repo URL. */
export function normalizeGitHubCloneUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.includes('github.com')) return null;

  let url = trimmed
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/i, '');

  if (url.startsWith('go:')) {
    const rest = url.slice(3).replace(/^\/\//, '');
    url = rest.startsWith('http') ? rest : `https://${rest}`;
  } else if (url.startsWith('git@github.com:')) {
    url = `https://github.com/${url.slice('git@github.com:'.length)}`;
  } else if (!/^https?:\/\//i.test(url) && url.includes('github.com')) {
    url = `https://${url.replace(/^\/+/, '')}`;
  }

  return parseGitHubUrl(url) ? url : null;
}

/** First GitHub clone URL on a repo row (canonical url, go: module key, or discovered repoUrl). */
export function githubUrlFromRepo(repo: { url: string; repoUrl?: string | null }): string | null {
  return (
    normalizeGitHubCloneUrl(repo.url) ??
    (repo.repoUrl ? normalizeGitHubCloneUrl(repo.repoUrl) : null)
  );
}

function githubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: GITHUB_REST_ACCEPT,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
  const t = token?.trim();
  if (t) headers.Authorization = `Bearer ${t}`;
  return headers;
}

/**
 * Whether private vulnerability reporting is enabled ("Report a vulnerability" on Security).
 * @see https://docs.github.com/en/rest/repos/repos#check-if-private-vulnerability-reporting-is-enabled-for-a-repository
 */
export async function getPrivateVulnerabilityReportingStatus(
  repoUrl: string,
  options?: { token?: string; timeoutMs?: number },
): Promise<PrivateVulnerabilityReportingResult> {
  if (!repoUrl.includes('github.com')) {
    return { ok: false, code: 'not_github' };
  }

  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    return { ok: false, code: 'parse_error', message: 'Could not parse owner/repo from URL' };
  }

  const { owner, repo } = parsed;
  const url = `https://api.github.com/repos/${owner}/${repo}/private-vulnerability-reporting`;
  const timeout = options?.timeoutMs ?? 15_000;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, {
      headers: githubHeaders(options?.token),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (response.status === 404) {
      return { ok: false, code: 'not_found', httpStatus: 404 };
    }

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        /* ignore */
      }
      return { ok: false, code: 'http_error', message, httpStatus: response.status };
    }

    const data = (await response.json()) as { enabled?: boolean };
    return { ok: true, enabled: Boolean(data.enabled) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'network', message: msg };
  }
}

/** Fetches repository metadata (stars, forks, etc.) from GitHub API. */
export async function fetchRepoMetadata(
  repoUrl: string,
  options?: { token?: string; timeoutMs?: number },
): Promise<GitHubRepoMetadata | null> {
  if (!repoUrl.includes('github.com')) return null;

  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) return null;

  const { owner, repo } = parsed;
  const timeout = options?.timeoutMs ?? 10_000;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: githubHeaders(options?.token),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return null;

    const data = (await response.json()) as {
      stargazers_count?: number;
      forks_count?: number;
      open_issues_count?: number;
      language?: string | null;
      archived?: boolean;
      fork?: boolean;
      pushed_at?: string | null;
      description?: string | null;
    };

    return {
      stars: data.stargazers_count ?? 0,
      forks: data.forks_count ?? 0,
      openIssues: data.open_issues_count ?? 0,
      language: data.language ?? undefined,
      archived: data.archived ?? undefined,
      isFork: data.fork ?? undefined,
      pushedAt: data.pushed_at ?? undefined,
      description: data.description ?? undefined,
    };
  } catch {
    return null;
  }
}

export interface GitHubRepoSnapshot {
  githubStars: number | null;
  githubForks: number | null;
  privateVulnerabilityReportingEnabled: boolean | null;
}

/** Fetch stars/forks and PVR for a GitHub repo URL. */
export async function fetchGitHubRepoSnapshot(
  repoUrl: string,
  token?: string,
): Promise<GitHubRepoSnapshot> {
  const [meta, pvr] = await Promise.all([
    fetchRepoMetadata(repoUrl, { token }),
    getPrivateVulnerabilityReportingStatus(repoUrl, { token }),
  ]);

  return {
    githubStars: meta?.stars ?? null,
    githubForks: meta?.forks ?? null,
    privateVulnerabilityReportingEnabled: pvr.ok ? pvr.enabled : null,
  };
}
