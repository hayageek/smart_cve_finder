import path from 'path';
import fs from 'fs';
import { prisma } from '../db/client.js';
import { findingArtifactsDir, type ArtifactFilename } from '../lib/artifact-files.js';

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export type SaveArtifactsInput = {
  reportMd?: string;
  payloadPy?: string;
  exploitPy?: string;
};

function writeIfPresent(dir: string, filename: ArtifactFilename, content: string | undefined): string | null {
  if (content === undefined) return null;
  if (Buffer.byteLength(content, 'utf-8') > MAX_ARTIFACT_BYTES) {
    throw new Error(`${filename} exceeds maximum size of ${MAX_ARTIFACT_BYTES} bytes`);
  }
  const abs = path.join(dir, filename);
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

export async function saveFindingArtifacts(findingId: string, input: SaveArtifactsInput) {
  const v = await prisma.vulnerability.findUnique({ where: { id: findingId } });
  if (!v) return null;

  const hasAny =
    input.reportMd !== undefined ||
    input.payloadPy !== undefined ||
    input.exploitPy !== undefined;
  if (!hasAny) {
    throw new Error('At least one artifact field is required');
  }

  const destDir = findingArtifactsDir(findingId);
  await fs.promises.mkdir(destDir, { recursive: true });

  const reportPath = writeIfPresent(destDir, 'report.md', input.reportMd) ?? v.reportPath;
  const payloadPath = writeIfPresent(destDir, 'payload.py', input.payloadPy) ?? v.payloadPath;
  const exploitPath = writeIfPresent(destDir, 'exploit.py', input.exploitPy) ?? v.exploitPath;

  const updated = await prisma.vulnerability.update({
    where: { id: findingId },
    data: {
      reportPath: input.reportMd !== undefined ? reportPath : v.reportPath,
      payloadPath: input.payloadPy !== undefined ? payloadPath : v.payloadPath,
      exploitPath: input.exploitPy !== undefined ? exploitPath : v.exploitPath,
    },
  });

  return {
    id: updated.id,
    reportPath: updated.reportPath,
    exploitPath: updated.exploitPath,
    payloadPath: updated.payloadPath,
    savedDir: destDir,
  };
}
