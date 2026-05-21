import type { Prisma, PrismaClient } from '@prisma/client';
import type { BridgedLogger } from './logger.js';

type ScanJobUpdateData = Prisma.ScanJobUpdateInput;

export function isRecordNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2025';
}

/** Update a ScanJob row; returns false if the row was deleted (stale queue job). */
export async function updateScanJob(
  prisma: PrismaClient,
  scanJobId: string,
  data: ScanJobUpdateData,
): Promise<boolean> {
  try {
    await prisma.scanJob.update({ where: { id: scanJobId }, data });
    return true;
  } catch (err) {
    if (isRecordNotFound(err)) return false;
    throw err;
  }
}

/** True when the ScanJob row still exists in the database. */
export async function scanJobExists(prisma: PrismaClient, scanJobId: string): Promise<boolean> {
  const row = await prisma.scanJob.findUnique({ where: { id: scanJobId }, select: { id: true } });
  return row !== null;
}

/**
 * Skip processing when the DB row was removed (e.g. scan history cleared) but BullMQ
 * still has a pending job payload referencing the old scanJobId.
 */
export async function requireScanJob(
  prisma: PrismaClient,
  scanJobId: string,
  jobLog: BridgedLogger,
): Promise<boolean> {
  if (await scanJobExists(prisma, scanJobId)) return true;
  jobLog.warn('ScanJob record missing (cleared from DB?) — skipping stale queue job');
  return false;
}
