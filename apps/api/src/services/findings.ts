import { prisma } from '../db/client.js';
import {
  ARTIFACT_FILENAMES,
  readArtifactText,
  type ArtifactFilename,
} from '../lib/artifact-files.js';

export type SearchFindingsParams = {
  cwe?: string;
  repoUrl?: string;
  org?: string;
  page?: number;
  pageSize?: number;
  dropped?: 'yes' | 'no' | 'all';
};

function buildSearchWhere(params: SearchFindingsParams): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const dropped = params.dropped ?? 'no';
  if (dropped === 'no') where.dropped = false;
  if (dropped === 'yes') where.dropped = true;

  if (params.cwe) {
    where.cwe = { contains: params.cwe, mode: 'insensitive' };
  }

  const repoFilters: Record<string, unknown>[] = [];
  if (params.repoUrl) {
    repoFilters.push({ url: { contains: params.repoUrl, mode: 'insensitive' } });
  }
  if (params.org) {
    repoFilters.push({ url: { contains: `/${params.org}/`, mode: 'insensitive' } });
  }
  if (repoFilters.length === 1) {
    where.scanJob = { repo: repoFilters[0] };
  } else if (repoFilters.length > 1) {
    where.scanJob = { repo: { AND: repoFilters } };
  }

  return where;
}

export async function searchFindings(params: SearchFindingsParams) {
  const page = params.page ?? 1;
  const pageSize = Math.min(params.pageSize ?? 20, 100);
  const where = buildSearchWhere(params);

  const [rows, total] = await Promise.all([
    prisma.vulnerability.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: { scanJob: { include: { repo: { select: { url: true } } } } },
    }),
    prisma.vulnerability.count({ where }),
  ]);

  return {
    data: rows.map((v) => ({
      id: v.id,
      cwe: v.cwe,
      severity: v.severity,
      path: v.path,
      lineStart: v.lineStart,
      lineEnd: v.lineEnd,
      repoUrl: v.scanJob.repo.url,
      exploitStatus: v.exploitStatus,
      dropped: v.dropped,
      createdAt: v.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function getFindingDetails(findingId: string) {
  const v = await prisma.vulnerability.findUnique({
    where: { id: findingId },
    include: { scanJob: { include: { repo: true } } },
  });
  if (!v) return null;

  const pathMap: Record<ArtifactFilename, string | null> = {
    'report.md': v.reportPath,
    'exploit.py': v.exploitPath,
    'payload.py': v.payloadPath,
  };

  const artifacts: Record<string, { present: boolean; content: string | null }> = {};
  for (const name of ARTIFACT_FILENAMES) {
    const content = await readArtifactText(findingId, name, pathMap[name]);
    artifacts[name] = { present: content !== null, content };
  }

  return {
    id: v.id,
    scanJobId: v.scanJobId,
    repoUrl: v.scanJob.repo.url,
    repo: {
      url: v.scanJob.repo.url,
      packageType: v.scanJob.repo.packageType,
      packageName: v.scanJob.repo.packageName,
      provider: v.scanJob.repo.provider,
    },
    checkId: v.checkId,
    path: v.path,
    lineStart: v.lineStart,
    lineEnd: v.lineEnd,
    severity: v.severity,
    cwe: v.cwe,
    vulnType: v.vulnType,
    message: v.message,
    metadataJson: v.metadataJson,
    isFalsePositive: v.isFalsePositive,
    cvssScore: v.cvssScore,
    dropped: v.dropped,
    dropReason: v.dropReason,
    dropEvidence: v.dropEvidence,
    exploitStatus: v.exploitStatus,
    reportPath: v.reportPath,
    exploitPath: v.exploitPath,
    payloadPath: v.payloadPath,
    exploitError: v.exploitError,
    exploitAttempts: v.exploitAttempts,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
    artifacts,
  };
}

export async function setFindingExploitable(
  findingId: string,
  exploitable: boolean,
  note?: string,
) {
  const v = await prisma.vulnerability.findUnique({ where: { id: findingId } });
  if (!v) return null;

  const updated = await prisma.vulnerability.update({
    where: { id: findingId },
    data: {
      exploitStatus: exploitable ? 'done' : 'failed',
      exploitError: exploitable ? null : (note ?? 'Marked not exploitable via MCP'),
    },
  });

  return {
    id: updated.id,
    exploitStatus: updated.exploitStatus,
    exploitError: updated.exploitError,
  };
}
