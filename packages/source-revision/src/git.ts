import { execFile } from 'child_process';
import { promisify } from 'util';
import { fetchGitHubHeadCommitSha, normalizeGitHubCloneUrl } from '@secscan/shared';
import type { RemoteRevision, RevisionLookupOptions, RevisionLookupResult } from './types.js';

const execFileAsync = promisify(execFile);

function gitRevision(sha: string, source: RemoteRevision['source']): RemoteRevision {
  return {
    revision: sha,
    kind: 'git-commit',
    label: sha.slice(0, 12),
    source,
  };
}

/** Resolve HEAD via GitHub REST API (no git binary). */
async function resolveGitHubApiRevision(
  cloneUrl: string,
  githubToken?: string,
): Promise<RevisionLookupResult | null> {
  const normalized = normalizeGitHubCloneUrl(cloneUrl);
  if (!normalized) return null;

  const result = await fetchGitHubHeadCommitSha(normalized, { token: githubToken });
  if (!result.ok) {
    return {
      ok: false,
      error: `GitHub API: ${result.message ?? result.code}`,
    };
  }

  return { ok: true, remote: gitRevision(result.sha, 'github-api') };
}

/** Resolve HEAD via git ls-remote (works for any git host). */
async function resolveGitLsRemoteRevision(cloneUrl: string): Promise<RevisionLookupResult> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-remote', '--quiet', cloneUrl, 'HEAD'],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    const line = stdout.trim().split('\n').find((l) => l.trim().length > 0);
    if (!line) {
      return { ok: false, error: `git ls-remote returned no HEAD for ${cloneUrl}` };
    }
    const sha = line.split(/\s+/)[0]?.trim();
    if (!sha || sha.length < 7) {
      return { ok: false, error: `git ls-remote returned invalid HEAD line: ${line}` };
    }
    return { ok: true, remote: gitRevision(sha, 'git-ls-remote') };
  } catch (err) {
    return { ok: false, error: `git ls-remote failed for ${cloneUrl}: ${String(err)}` };
  }
}

/**
 * Resolve the current HEAD commit for a remote git URL without cloning.
 * GitHub.com URLs use the REST API first; all hosts fall back to git ls-remote.
 */
export async function resolveGitRemoteRevision(
  cloneUrl: string,
  options: RevisionLookupOptions = {},
): Promise<RevisionLookupResult> {
  const isGitHub = Boolean(normalizeGitHubCloneUrl(cloneUrl) ?? (cloneUrl.includes('github.com') ? cloneUrl : null));

  if (isGitHub) {
    const apiResult = await resolveGitHubApiRevision(cloneUrl, options.githubToken);
    if (apiResult?.ok) {
      return apiResult;
    }
    const apiError = apiResult && !apiResult.ok ? apiResult.error : 'not a GitHub URL';
    const lsRemote = await resolveGitLsRemoteRevision(cloneUrl);
    if (lsRemote.ok) {
      return lsRemote;
    }
    return {
      ok: false,
      error: `GitHub API failed (${apiError}); git ls-remote failed (${lsRemote.error})`,
    };
  }

  return resolveGitLsRemoteRevision(cloneUrl);
}
