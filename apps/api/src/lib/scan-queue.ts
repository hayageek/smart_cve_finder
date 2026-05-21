import type { ScanJobData } from '@secscan/shared';
import { prisma } from '../db/client.js';
import { scanQueue } from '../queues/index.js';

/** Repo statuses shown as "in queue" in UI (includes DB-only queued, before BullMQ pick-up). */
export const REPO_IN_SCAN_STATUSES = ['queued', 'cloning', 'scanning', 'exploiting'] as const;

/** Repo statuses where a worker is actively processing — block duplicate enqueue/rescan. */
export const REPO_BUSY_STATUSES = ['cloning', 'scanning', 'exploiting'] as const;

export function isRepoInScanPipeline(status: string): boolean {
  return (REPO_IN_SCAN_STATUSES as readonly string[]).includes(status);
}

export function isRepoActivelyScanning(status: string): boolean {
  return (REPO_BUSY_STATUSES as readonly string[]).includes(status);
}

export type EnqueueScanResult =
  | { queued: true; scanJobId: string }
  | { queued: false; reason: 'already-in-queue' };

/**
 * Enqueue a repo/package for scanning unless it is already queued or in progress.
 * Uses BullMQ deduplication on repoUrl to avoid duplicate waiting jobs.
 */
export async function enqueueScanJob(
  repoId: string,
  payload: ScanJobData,
): Promise<EnqueueScanResult> {
  const repo = await prisma.repo.findUnique({
    where: { id: repoId },
    select: { status: true },
  });
  if (!repo) {
    throw new Error('Repo not found');
  }

  if (isRepoActivelyScanning(repo.status)) {
    return { queued: false, reason: 'already-in-queue' };
  }

  // Block only if another scan is in-flight (not the scanJob we are enqueueing now).
  const blocking = await prisma.scanJob.findFirst({
    where: {
      repoId,
      id: { not: payload.scanJobId },
      OR: [
        { status: { in: ['cloning', 'scanning', 'exploiting', 'exploit-gen'] } },
        { status: 'pending', bullJobId: { not: null } },
      ],
    },
    select: { id: true },
  });
  if (blocking) {
    return { queued: false, reason: 'already-in-queue' };
  }

  await scanQueue.add('scan', payload, {
    deduplication: { id: payload.repoUrl },
  });
  return { queued: true, scanJobId: payload.scanJobId };
}
