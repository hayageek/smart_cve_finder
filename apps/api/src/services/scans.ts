import type { PackageType, ScanMode } from '@secscan/shared';
import { prisma } from '../db/client.js';
import {
  enqueueScanJob,
  isRepoActivelyScanning,
  isRepoInScanPipeline,
} from '../lib/scan-queue.js';
import {
  entryToCreateData,
  entryToScanJobPayload,
  type ParsedEntry,
  scanTargetToEntry,
  type ScanTargetInput,
} from '../lib/repo-import.js';
import { emitActivityEvent } from '../sockets/index.js';
import { evaluateRevisionGate } from '@secscan/source-revision';
import { getQueueStats } from '../queues/index.js';
import { config } from '../config.js';

/** Repo statuses that block re-queue while a scan is in flight. */

export type EnqueueScanItemResult =
  | {
      url: string;
      action: 'queued';
      repoId: string;
      scanJobId: string;
      created: boolean;
    }
  | {
      url: string;
      action: 'skipped';
      reason: 'invalid' | 'duplicate-in-request' | 'already-scanned' | 'already-in-queue' | 'unchanged-revision';
      repoId?: string;
      repoStatus?: string;
      scanJobId?: string;
      message?: string;
    };

export type EnqueueScanResult = {
  results: EnqueueScanItemResult[];
  queued: number;
  skipped: number;
};

function formatScanJob(job: {
  id: string;
  status: string;
  stage: string | null;
  scanMode?: string;
  bullJobId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  createdAt: Date;
  _count?: { vulnerabilities: number; secrets: number };
  vulnerabilities?: { exploitStatus: string | null }[];
}) {
  const vulnCount = job._count?.vulnerabilities ?? 0;
  const secretCount = job._count?.secrets ?? 0;
  const exploitCount = job.vulnerabilities?.filter((v) => v.exploitStatus !== null).length ?? 0;
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    scanMode: (job.scanMode ?? 'both') as ScanMode,
    bullJobId: job.bullJobId,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    vulnCount,
    secretCount,
    exploitCount,
    durationMs:
      job.startedAt && job.finishedAt
        ? job.finishedAt.getTime() - job.startedAt.getTime()
        : null,
  };
}

async function queueExistingRepo(
  repo: {
    id: string;
    url: string;
    status: string;
    packageType: string;
    packageName: string | null;
    packageVersion: string | null;
    lastScannedRevision: string | null;
  },
  force: boolean,
  scanMode: ScanMode = 'both',
): Promise<EnqueueScanItemResult> {
  if (isRepoActivelyScanning(repo.status)) {
    return {
      url: repo.url,
      action: 'skipped',
      reason: 'already-in-queue',
      repoId: repo.id,
      repoStatus: repo.status,
      message: 'Repo is actively being scanned',
    };
  }

  if (!force && isRepoInScanPipeline(repo.status)) {
    console.info(`[revision-gate] enqueue skip (in pipeline): repo=${repo.url} status=${repo.status}`);
    return {
      url: repo.url,
      action: 'skipped',
      reason: 'already-in-queue',
      repoId: repo.id,
      repoStatus: repo.status,
      message: 'Repo is already queued or in the scan pipeline',
    };
  }

  const gate = await evaluateRevisionGate(repo, {
    force,
    githubToken: config.GITHUB_TOKEN,
  });
  console.info(`[revision-gate] enqueue: ${gate.log}`);
  if (gate.action === 'skip') {
    emitActivityEvent({
      id: repo.id,
      timestamp: new Date().toISOString(),
      type: 'info',
      message: `[revision-gate] ${gate.message} — ${repo.packageName ?? repo.url}`,
      repoUrl: repo.url,
    });
    return {
      url: repo.url,
      action: 'skipped',
      reason: 'unchanged-revision',
      repoId: repo.id,
      repoStatus: repo.status,
      message: gate.message,
    };
  }

  if (gate.lookupFailed) {
    console.warn(`[revision-gate] enqueue fail-open: repo=${repo.url} error=${gate.lookupError}`);
  } else if (gate.remote) {
    console.info(
      `[revision-gate] enqueue proceed: repo=${repo.url} remote=${gate.remote.kind}:${gate.remote.revision}`,
    );
  }

  const scanJob = await prisma.scanJob.create({ data: { repoId: repo.id, status: 'pending', scanMode } });
  const result = await enqueueScanJob(repo.id, {
    repoUrl: repo.url,
    packageType: (repo.packageType as PackageType) ?? 'git',
    packageName: repo.packageName ?? undefined,
    packageVersion: repo.packageVersion ?? undefined,
    scanJobId: scanJob.id,
    scanMode,
    ...(force ? { forceRescan: true } : {}),
  });

  if (!result.queued) {
    await prisma.scanJob.delete({ where: { id: scanJob.id } }).catch(() => undefined);
    return {
      url: repo.url,
      action: 'skipped',
      reason: 'already-in-queue',
      repoId: repo.id,
      repoStatus: repo.status,
      message: 'Could not enqueue — another scan job is in progress',
    };
  }

  await prisma.repo.update({ where: { id: repo.id }, data: { status: 'queued' } });

  emitActivityEvent({
    id: scanJob.id,
    timestamp: new Date().toISOString(),
    type: 'info',
    message: `${force ? 'Re-scan' : 'Scan'} queued for ${repo.packageName ?? repo.url}`,
    repoUrl: repo.url,
  });

  return {
    url: repo.url,
    action: 'queued',
    repoId: repo.id,
    scanJobId: scanJob.id,
    created: false,
  };
}

async function queueNewEntry(entry: ParsedEntry, scanMode: ScanMode = 'both'): Promise<EnqueueScanItemResult> {
  const repo = await prisma.repo.create({ data: entryToCreateData(entry) });
  const scanJob = await prisma.scanJob.create({ data: { repoId: repo.id, status: 'pending', scanMode } });
  const result = await enqueueScanJob(repo.id, entryToScanJobPayload(entry, scanJob.id, scanMode));

  if (!result.queued) {
    await prisma.scanJob.delete({ where: { id: scanJob.id } }).catch(() => undefined);
    return {
      url: entry.url,
      action: 'skipped',
      reason: 'already-in-queue',
      repoId: repo.id,
      repoStatus: repo.status,
      message: 'Repo created but could not enqueue',
    };
  }

  emitActivityEvent({
    id: scanJob.id,
    timestamp: new Date().toISOString(),
    type: 'info',
    message: `Queued ${repo.packageName ?? repo.url} (${repo.packageType}) for scanning`,
    repoUrl: repo.url,
  });

  return {
    url: entry.url,
    action: 'queued',
    repoId: repo.id,
    scanJobId: scanJob.id,
    created: true,
  };
}

export async function enqueueScans(
  targets: ScanTargetInput[],
  options: { force?: boolean; scanMode?: ScanMode } = {},
): Promise<EnqueueScanResult> {
  const force = options.force ?? false;
  const scanMode = options.scanMode ?? 'both';
  const results: EnqueueScanItemResult[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const entry = scanTargetToEntry(target);
    if (!entry) {
      results.push({
        url: 'gitUrl' in target ? target.gitUrl : `${target.packageType}:${target.packageName}`,
        action: 'skipped',
        reason: 'invalid',
        message: 'Invalid target — use gitUrl (http/https) or packageName + packageType (npm|pip|cargo|go|gem)',
      });
      continue;
    }

    if (seen.has(entry.url)) {
      results.push({
        url: entry.url,
        action: 'skipped',
        reason: 'duplicate-in-request',
        message: 'Duplicate entry in this request',
      });
      continue;
    }
    seen.add(entry.url);

    const existing = await prisma.repo.findUnique({
      where: { url: entry.url },
      select: {
        id: true,
        url: true,
        status: true,
        packageType: true,
        packageName: true,
        packageVersion: true,
        lastScannedRevision: true,
      },
    });

    if (existing) {
      results.push(await queueExistingRepo(existing, force, scanMode));
    } else {
      results.push(await queueNewEntry(entry, scanMode));
    }
  }

  return {
    results,
    queued: results.filter((r) => r.action === 'queued').length,
    skipped: results.filter((r) => r.action === 'skipped').length,
  };
}

export type GetScanStatusParams = {
  repoId?: string;
  repoUrl?: string;
  scanJobId?: string;
};

export async function getScanStatus(params: GetScanStatusParams) {
  const { repoId, repoUrl, scanJobId } = params;
  if (!repoId && !repoUrl && !scanJobId) {
    throw new Error('Provide at least one of repo_id, repo_url, or scan_job_id');
  }

  if (scanJobId) {
    const job = await prisma.scanJob.findUnique({
      where: { id: scanJobId },
      include: {
        repo: true,
        _count: { select: { vulnerabilities: true, secrets: true } },
        vulnerabilities: { select: { exploitStatus: true, severity: true } },
      },
    });
    if (!job) return null;

    const bySeverity = job.vulnerabilities.reduce<Record<string, number>>((acc, v) => {
      acc[v.severity] = (acc[v.severity] ?? 0) + 1;
      return acc;
    }, {});

    return {
      repo: {
        id: job.repo.id,
        url: job.repo.url,
        repoUrl: job.repo.repoUrl,
        packageName: job.repo.packageName,
        packageType: job.repo.packageType,
        packageVersion: job.repo.packageVersion,
        provider: job.repo.provider,
        status: job.repo.status,
        isPrivate: job.repo.isPrivate,
        lastScannedAt: job.repo.lastScannedAt?.toISOString() ?? null,
        inScanPipeline: isRepoInScanPipeline(job.repo.status),
        createdAt: job.repo.createdAt.toISOString(),
      },
      scanJob: formatScanJob(job),
      findingsBySeverity: bySeverity,
    };
  }

  const repo = await prisma.repo.findFirst({
    where: repoId
      ? { id: repoId }
      : {
          OR: [
            { url: repoUrl! },
            { url: { equals: repoUrl!, mode: 'insensitive' } },
            { repoUrl: { contains: repoUrl!, mode: 'insensitive' } },
          ],
        },
    include: {
      scanJobs: {
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: {
          _count: { select: { vulnerabilities: true, secrets: true } },
          vulnerabilities: { select: { exploitStatus: true } },
        },
      },
    },
  });

  if (!repo) return null;

  const latestJob = repo.scanJobs[0];

  return {
    repo: {
      id: repo.id,
      url: repo.url,
      repoUrl: repo.repoUrl,
      packageName: repo.packageName,
      packageType: repo.packageType,
      packageVersion: repo.packageVersion,
      provider: repo.provider,
      status: repo.status,
      isPrivate: repo.isPrivate,
      lastScannedAt: repo.lastScannedAt?.toISOString() ?? null,
      inScanPipeline: isRepoInScanPipeline(repo.status),
      createdAt: repo.createdAt.toISOString(),
    },
    latestScanJob: latestJob ? formatScanJob(latestJob) : null,
    recentScanJobs: repo.scanJobs.map(formatScanJob),
  };
}

export async function getScanQueueOverview() {
  const stats = await getQueueStats();
  const [pendingDb, activeDb] = await Promise.all([
    prisma.scanJob.count({ where: { status: 'pending' } }),
    prisma.scanJob.count({
      where: { status: { in: ['cloning', 'scanning', 'exploiting', 'exploit-gen'] } },
    }),
  ]);

  return {
    bullmq: stats,
    database: {
      pendingScanJobs: pendingDb,
      activeScanJobs: activeDb,
    },
  };
}
