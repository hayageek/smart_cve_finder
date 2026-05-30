import fs from 'fs';
import { prisma } from '../db/client.js';
import {
  artifactAbsolutePath,
  findingArtifactsDir,
  resolveArtifactPath,
  storedArtifactRelPath,
  type ArtifactFilename,
} from '../lib/artifact-files.js';

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export type SaveArtifactsInput = {
  reportMd?: string;
  payloadPy?: string;
  exploitPy?: string;
};

export type SaveArtifactBuffersInput = {
  reportMd?: Buffer;
  payloadPy?: Buffer;
  exploitPy?: Buffer;
};

/** Reject IDE accidentally sending a host filesystem path instead of file contents. */
function assertNotHostPath(content: string, field: string): void {
  const trimmed = content.trim();
  if (trimmed.length > 8000 || trimmed.includes('\n')) return;
  if (/^(\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:\\).+\.(md|py)$/i.test(trimmed)) {
    throw new Error(
      `${field} looks like a host file path, not file content. ` +
        'Read the file in your IDE and upload via POST /api/vulnerabilities/:id/artifacts/upload ' +
        'or pass the full text/base64 content to save_finding_artifacts.',
    );
  }
}

function writeBuffer(
  findingId: string,
  filename: ArtifactFilename,
  data: Buffer,
): string {
  if (data.length > MAX_ARTIFACT_BYTES) {
    throw new Error(`${filename} exceeds maximum size of ${MAX_ARTIFACT_BYTES} bytes`);
  }
  const abs = artifactAbsolutePath(findingId, filename);
  fs.mkdirSync(findingArtifactsDir(findingId), { recursive: true });
  fs.writeFileSync(abs, data);
  return storedArtifactRelPath(findingId, filename);
}

function writeText(
  findingId: string,
  filename: ArtifactFilename,
  content: string,
): string {
  assertNotHostPath(content, filename);
  return writeBuffer(findingId, filename, Buffer.from(content, 'utf-8'));
}

async function persistArtifactPaths(
  findingId: string,
  updates: { reportPath?: string; payloadPath?: string; exploitPath?: string },
) {
  const v = await prisma.vulnerability.findUnique({ where: { id: findingId } });
  if (!v) return null;

  const data: {
    reportPath: string | null;
    payloadPath: string | null;
    exploitPath: string | null;
    exploitStatus?: string;
  } = {
    reportPath: updates.reportPath ?? v.reportPath,
    payloadPath: updates.payloadPath ?? v.payloadPath,
    exploitPath: updates.exploitPath ?? v.exploitPath,
  };

  // Mark as attempted so exploit file routes work; analyst can set done/failed later.
  if (v.exploitStatus === null && (updates.reportPath || updates.payloadPath || updates.exploitPath)) {
    data.exploitStatus = 'failed';
  }

  const updated = await prisma.vulnerability.update({
    where: { id: findingId },
    data,
  });

  return {
    id: updated.id,
    reportPath: updated.reportPath,
    exploitPath: updated.exploitPath,
    payloadPath: updated.payloadPath,
    exploitStatus: updated.exploitStatus,
    savedDir: findingArtifactsDir(findingId),
  };
}

export async function saveFindingArtifactBuffers(
  findingId: string,
  input: SaveArtifactBuffersInput,
) {
  const hasAny =
    input.reportMd !== undefined ||
    input.payloadPy !== undefined ||
    input.exploitPy !== undefined;
  if (!hasAny) {
    throw new Error('At least one artifact file is required');
  }

  const updates: { reportPath?: string; payloadPath?: string; exploitPath?: string } = {};
  if (input.reportMd !== undefined) {
    updates.reportPath = writeBuffer(findingId, 'report.md', input.reportMd);
  }
  if (input.payloadPy !== undefined) {
    updates.payloadPath = writeBuffer(findingId, 'payload.py', input.payloadPy);
  }
  if (input.exploitPy !== undefined) {
    updates.exploitPath = writeBuffer(findingId, 'exploit.py', input.exploitPy);
  }

  return persistArtifactPaths(findingId, updates);
}

export async function saveFindingArtifacts(findingId: string, input: SaveArtifactsInput) {
  const hasAny =
    input.reportMd !== undefined ||
    input.payloadPy !== undefined ||
    input.exploitPy !== undefined;
  if (!hasAny) {
    throw new Error('At least one artifact field is required');
  }

  const updates: { reportPath?: string; payloadPath?: string; exploitPath?: string } = {};
  if (input.reportMd !== undefined) {
    updates.reportPath = writeText(findingId, 'report.md', input.reportMd);
  }
  if (input.payloadPy !== undefined) {
    updates.payloadPath = writeText(findingId, 'payload.py', input.payloadPy);
  }
  if (input.exploitPy !== undefined) {
    updates.exploitPath = writeText(findingId, 'exploit.py', input.exploitPy);
  }

  return persistArtifactPaths(findingId, updates);
}

export function deleteFindingArtifacts(vuln: {
  id: string;
  reportPath: string | null;
  exploitPath: string | null;
  payloadPath: string | null;
}): void {
  const names: ArtifactFilename[] = ['report.md', 'exploit.py', 'payload.py'];
  const stored = [vuln.reportPath, vuln.exploitPath, vuln.payloadPath];
  for (let i = 0; i < names.length; i++) {
    const p = stored[i];
    if (!p) continue;
    const abs = resolveArtifactPath(vuln.id, names[i]!, p);
    if (abs) fs.rmSync(abs, { force: true });
  }
  const dir = findingArtifactsDir(vuln.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Decode optional base64 fields from MCP (prefix data: or raw base64). */
export function decodeArtifactBase64(value: string): Buffer {
  const trimmed = value.trim();
  const b64 = trimmed.includes(',') ? trimmed.split(',').pop()! : trimmed;
  return Buffer.from(b64, 'base64');
}
