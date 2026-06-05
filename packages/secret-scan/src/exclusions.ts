import picomatch from 'picomatch';
import { loadExclusionGlobs } from '@secscan/cve-semgrep';

let pathMatcher: picomatch.Matcher | null = null;

function exclusionMatcher(): picomatch.Matcher {
  if (!pathMatcher) {
    const globs = loadExclusionGlobs();
    pathMatcher = picomatch(globs, { dot: true, bash: true });
  }
  return pathMatcher;
}

/** True when `filePath` matches a shared exclusions.yml glob (same rules as Semgrep/CVE hunter). */
export function isExcludedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (!normalized) return false;
  return exclusionMatcher()(normalized);
}

/** Reset cached matcher (tests or hot reload). */
export function resetExclusionCache(): void {
  pathMatcher = null;
}
