import { prisma } from '../db/client.js';
import {
  ARTIFACT_FILENAMES,
  readArtifactText,
  type ArtifactFilename,
} from '../lib/artifact-files.js';

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

export type SearchFindingsParams = {
  cwe?: string;
  repoUrl?: string;
  org?: string;
  page?: number;
  pageSize?: number;
  dropped?: 'yes' | 'no' | 'all';
};

export type NextUnexploitedParams = {
  cwe?: string;
  repoUrl?: string;
  org?: string;
  minSeverity?: string;
  /** Include failed attempts (no successful exploit) for IDE re-work. Default false = only never-attempted. */
  includeFailed?: boolean;
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

/**
 * Next confirmed finding with no successful exploit — for IDE-driven research.
 * Default: exploitStatus is null (never attempted). Optionally includes failed.
 */
export async function getNextUnexploitedFinding(params: NextUnexploitedParams = {}) {
  const where: Record<string, unknown> = {
    dropped: false,
    isFalsePositive: false,
  };

  if (params.includeFailed) {
    where.OR = [
      { exploitStatus: null },
      { exploitStatus: 'failed' },
    ];
  } else {
    where.exploitStatus = null;
  }

  if (params.cwe) {
    where.cwe = { contains: params.cwe, mode: 'insensitive' };
  }

  if (params.minSeverity) {
    const idx = SEVERITY_ORDER.indexOf(params.minSeverity as (typeof SEVERITY_ORDER)[number]);
    if (idx >= 0) {
      where.severity = { in: SEVERITY_ORDER.slice(0, idx + 1) };
    }
  }

  const repoFilters: Record<string, unknown>[] = [];
  if (params.repoUrl) repoFilters.push({ url: { contains: params.repoUrl, mode: 'insensitive' } });
  if (params.org) repoFilters.push({ url: { contains: `/${params.org}/`, mode: 'insensitive' } });
  if (repoFilters.length === 1) {
    where.scanJob = { repo: repoFilters[0] };
  } else if (repoFilters.length > 1) {
    where.scanJob = { repo: { AND: repoFilters } };
  }

  const candidates = await prisma.vulnerability.findMany({
    where,
    take: 200,
    orderBy: [{ cvssScore: 'desc' }, { createdAt: 'asc' }],
    include: { scanJob: { include: { repo: { select: { url: true } } } } },
  });

  if (!candidates.length) {
    return { finding: null, message: 'No unexploited findings match the filters' };
  }

  const sorted = [...candidates].sort((a, b) => {
    const sa = SEVERITY_ORDER.indexOf(a.severity as (typeof SEVERITY_ORDER)[number]);
    const sb = SEVERITY_ORDER.indexOf(b.severity as (typeof SEVERITY_ORDER)[number]);
    const ai = sa === -1 ? 99 : sa;
    const bi = sb === -1 ? 99 : sb;
    if (ai !== bi) return ai - bi;
    const cvssDiff = (b.cvssScore ?? 0) - (a.cvssScore ?? 0);
    if (cvssDiff !== 0) return cvssDiff;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  const v = sorted[0]!;
  const details = await getFindingDetails(v.id);
  return {
    finding: details,
    summary: {
      id: v.id,
      cwe: v.cwe,
      severity: v.severity,
      path: v.path,
      repoUrl: v.scanJob.repo.url,
      exploitStatus: v.exploitStatus,
    },
    remainingApprox: candidates.length - 1,
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
    'run.sh': null,
    'docker_run_script.sh': null,
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
