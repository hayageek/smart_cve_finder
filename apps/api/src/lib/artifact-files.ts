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
