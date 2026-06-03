import path from 'path';
import fs from 'fs';
import { config } from '../config.js';

export const ARTIFACT_FILENAMES = ['report.md', 'exploit.py', 'payload.py', 'run.sh', 'docker_run_script.sh'] as const;
export type ArtifactFilename = (typeof ARTIFACT_FILENAMES)[number];

/** DB-safe path relative to REPORTS_DIR, e.g. `{findingId}/report.md` */
export function storedArtifactRelPath(findingId: string, filename: ArtifactFilename): string {
  return path.posix.join(findingId, filename);
}

export function findingArtifactsDir(findingId: string): string {
  return path.join(config.REPORTS_DIR, findingId);
}

/** Repo-relative path shown in UI: `volumes/atlassian_reports/{findingId}`. */
export function reportFolderDisplayPath(findingId: string): string {
  return path.posix.join('volumes', 'atlassian_reports', findingId);
}

export function artifactAbsolutePath(findingId: string, filename: ArtifactFilename): string {
  return path.join(findingArtifactsDir(findingId), filename);
}

/**
 * Resolve readable path: prefer canonical `{REPORTS_DIR}/{id}/{file}`, then stored path.
 */
export function resolveArtifactPath(
  findingId: string,
  filename: ArtifactFilename,
  storedPath: string | null,
): string | null {
  if (!ARTIFACT_FILENAMES.includes(filename)) return null;

  const canonical = artifactAbsolutePath(findingId, filename);
  if (fs.existsSync(canonical)) return canonical;

  if (!storedPath) return null;

  const candidates: string[] = [];

  if (path.isAbsolute(storedPath)) {
    candidates.push(storedPath);
  } else {
    candidates.push(path.join(config.REPORTS_DIR, storedPath));
    // legacy: stored as just filename
    if (!storedPath.includes('/')) {
      candidates.push(path.join(findingArtifactsDir(findingId), storedPath));
    }
  }

  for (const abs of candidates) {
    if (fs.existsSync(abs)) return abs;
  }

  return null;
}

export async function readArtifactText(
  findingId: string,
  filename: ArtifactFilename,
  storedPath: string | null,
): Promise<string | null> {
  const abs = resolveArtifactPath(findingId, filename, storedPath);
  if (!abs) return null;
  return fs.promises.readFile(abs, 'utf-8');
}

/** Safe basename only — rejects path segments and traversal. */
export function isSafeArtifactBasename(filename: string): boolean {
  return filename.length > 0
    && filename.length <= 255
    && !filename.includes('/')
    && !filename.includes('\\')
    && filename !== '.'
    && filename !== '..'
    && /^[\w.\-+]+$/.test(filename);
}

/** All regular files under `{REPORTS_DIR}/{findingId}/`. */
export async function listFindingArtifactFiles(findingId: string): Promise<string[]> {
  const dir = findingArtifactsDir(findingId);
  if (!fs.existsSync(dir)) return [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
}

/** Resolve a file in the canonical finding artifacts directory. */
export function resolveFindingArtifactFile(findingId: string, filename: string): string | null {
  if (!isSafeArtifactBasename(filename)) return null;
  const abs = path.join(findingArtifactsDir(findingId), filename);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}
