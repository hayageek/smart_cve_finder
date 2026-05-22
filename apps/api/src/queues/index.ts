import { Queue, QueueEvents } from 'bullmq';
import { QUEUE_NAMES, type ScanJobData, type ExploitJobData } from '@secscan/shared';
import { redisOptions } from '../config.js';

export const scanQueue = new Queue<ScanJobData>(QUEUE_NAMES.REPO_SCAN, {
  connection: redisOptions,
  defaultJobOptions: {
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

export const exploitQueue = new Queue<ExploitJobData>(QUEUE_NAMES.EXPLOIT_GEN, {
  connection: redisOptions,
  defaultJobOptions: {
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

export const scanQueueEvents = new QueueEvents(QUEUE_NAMES.REPO_SCAN, { connection: redisOptions });
export const exploitQueueEvents = new QueueEvents(QUEUE_NAMES.EXPLOIT_GEN, { connection: redisOptions });

export async function getQueueStats(): Promise<Array<{ name: string; waiting: number; active: number; completed: number; failed: number; delayed: number }>> {
  const [scan, exploit] = await Promise.all([
    scanQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    exploitQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
  ]);
  const toStats = (name: string, counts: Record<string, number>) => ({
    name,
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
  });
  return [
    toStats(QUEUE_NAMES.REPO_SCAN, scan as Record<string, number>),
    toStats(QUEUE_NAMES.EXPLOIT_GEN, exploit as Record<string, number>),
  ];
}

export async function closeQueues() {
  await Promise.all([
    scanQueue.close(),
    exploitQueue.close(),
    scanQueueEvents.close(),
    exploitQueueEvents.close(),
  ]);
}
