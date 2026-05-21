import path from 'path';
import fs from 'fs';
import { config } from '../config.js';

export const ARTIFACT_FILENAMES = ['report.md', 'exploit.py', 'payload.py'] as const;
export type ArtifactFilename = (typeof ARTIFACT_FILENAMES)[number];

export function findingArtifactsDir(findingId: string): string {
  return path.join(config.REPORTS_DIR, findingId);
}

export function resolveArtifactPath(
  findingId: string,
  filename: ArtifactFilename,
  storedPath: string | null,
): string | null {
  if (!ARTIFACT_FILENAMES.includes(filename)) return null;

  if (storedPath) {
    const abs = path.isAbsolute(storedPath) ? storedPath : path.join(config.REPORTS_DIR, storedPath);
    if (fs.existsSync(abs)) return abs;
  }

  const defaultPath = path.join(findingArtifactsDir(findingId), filename);
  return fs.existsSync(defaultPath) ? defaultPath : null;
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
