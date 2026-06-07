import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import type { ProgramsFile } from './types.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..');

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;

  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(resolve(PACKAGE_ROOT, '.env'));
loadDotEnv(resolve(REPO_ROOT, '.env'));

export function packageRoot(): string {
  return PACKAGE_ROOT;
}

export function repoRoot(): string {
  return REPO_ROOT;
}

/** Resolve CLI paths from repo root when relative (npm workspace cwd is the package dir). */
export function resolveCliPath(path: string): string {
  if (path.startsWith('/')) return path;
  const fromCwd = resolve(process.cwd(), path);
  if (existsSync(fromCwd)) return fromCwd;
  return resolve(REPO_ROOT, path);
}

export function githubToken(): string | undefined {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  return token || undefined;
}

export const USER_AGENT = 'secscan-bugbounty-repos/1.0 (security-research)';

export function loadPrograms(path: string): ProgramsFile {
  const text = readFileSync(path, 'utf8');
  const parsed = parseYaml(text) as ProgramsFile;
  if (!parsed?.programs?.length) {
    throw new Error(`No programs found in ${path}`);
  }
  for (const program of parsed.programs) {
    if (!program.name?.trim()) throw new Error('Each program must have a name');
    if (!Array.isArray(program.orgs) || program.orgs.length === 0) {
      throw new Error(`Program "${program.name}" must have at least one org`);
    }
    program.orgs = program.orgs.map((o) => o.trim()).filter(Boolean);
  }
  return parsed;
}
