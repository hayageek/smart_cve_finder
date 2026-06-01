/** Strip git+, .git suffix, git:// prefix from registry-provided repo URLs. */
export function normaliseRepoUrl(raw?: string | null): string | null {
  if (!raw) return null;
  return (
    raw
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/\.git$/, '')
      .trim() || null
  );
}

export function repoUrlFromGoModule(modulePath: string): string | null {
  const parts = modulePath.split('/');
  if (parts.length < 3) return null;
  const host = parts[0];
  if (host === 'github.com' || host.endsWith('.github.com')) {
    return `https://${host}/${parts[1]}/${parts[2].replace(/\.git$/, '')}`;
  }
  if (host === 'gitlab.com' || host.endsWith('.gitlab.com')) {
    return `https://${host}/${parts[1]}/${parts[2].replace(/\.git$/, '')}`;
  }
  if (host === 'bitbucket.org') {
    return `https://${host}/${parts[1]}/${parts[2].replace(/\.git$/, '')}`;
  }
  return null;
}
