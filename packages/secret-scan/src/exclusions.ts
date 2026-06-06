import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import picomatch from 'picomatch';

let pathMatcher: picomatch.Matcher | null = null;

/**
 * Resolve the secret scanner's bundled `exclusions.yml`. The build step copies it
 * next to the compiled output (`dist/`); when running from source (tsx) it is read
 * directly from `src/`.
 */
function exclusionsPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'exclusions.yml'),
    path.join(here, '..', 'src', 'exclusions.yml'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

/**
 * Load the path/file exclusion globs from the secret scanner's `exclusions.yml`.
 * The file uses ripgrep-style `!`-prefixed globs; the leading `!` is stripped so
 * the glob can be matched directly. Returns an empty list if the file is missing.
 */
export function loadExclusionGlobs(): string[] {
  let text: string;
  try {
    text = readFileSync(exclusionsPath(), 'utf8');
  } catch {
    return [];
  }
  const globs: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*-\s*['"]?!(.+?)['"]?\s*$/);
    if (m) globs.push(m[1]);
  }
  return globs;
}

function exclusionMatcher(): picomatch.Matcher {
  if (!pathMatcher) {
    const globs = loadExclusionGlobs();
    pathMatcher = picomatch(globs, { dot: true, bash: true, nocase: true });
  }
  return pathMatcher;
}

/** True when `filePath` matches a secret-scan exclusions.yml glob. */
export function isExcludedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (!normalized) return false;
  return exclusionMatcher()(normalized);
}

/** Reset cached matcher (tests or hot reload). */
export function resetExclusionCache(): void {
  pathMatcher = null;
}
