import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { mkdir } from 'fs/promises';
import { Redis } from 'ioredis';
import { config, redisOptions } from './config.js';
import { prisma, ensureWorkerConfig } from './db/client.js';
import {
  initSocket,
  emitQueueStats,
  emitDashboardStats,
  emitLogLine,
  emitActivityEvent,
  emitJobActive,
  emitJobProgress,
  emitJobCompleted,
  emitJobFailed,
} from './sockets/index.js';
import { getQueueStats, scanQueue, cveQueue, exploitQueue, scanQueueEvents, cveQueueEvents, exploitQueueEvents, closeQueues } from './queues/index.js';
import { REDIS_CHANNELS, type LogLine, type ActivityEvent } from '@secscan/shared';

import reposRouter from './routes/repos.js';
import scansRouter from './routes/scans.js';
import vulnsRouter from './routes/vulnerabilities.js';
import exploitsRouter from './routes/exploits.js';
import workersRouter from './routes/workers.js';
import settingsRouter from './routes/settings.js';
import dashboardRouter from './routes/dashboard.js';
import { mountMcpRoutes } from './mcp/mount.js';

async function bootstrap() {
  await mkdir(config.WORKSPACES_DIR, { recursive: true });
  await mkdir(config.REPORTS_DIR, { recursive: true });
  await mkdir(config.LOGS_DIR, { recursive: true });

  await ensureWorkerConfig();

  const app = express();

  app.use(cors({ origin: config.CORS_ORIGINS.split(',') }));
  app.use(express.json({ limit: '10mb' }));

  mountMcpRoutes(app);

  app.use('/api/repos', reposRouter);
  app.use('/api/scans', scansRouter);
  app.use('/api/vulnerabilities', vulnsRouter);
  app.use('/api/exploits', exploitsRouter);
  app.use('/api/workers', workersRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/dashboard', dashboardRouter);

  app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

  const httpServer = http.createServer(app);
  const io = initSocket(httpServer);

  // ── Redis subscriber: relay worker log lines to Socket.IO ────────
  const logSubscriber = new Redis({
    ...redisOptions,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  });
  logSubscriber.on('error', () => {});
  logSubscriber.subscribe(REDIS_CHANNELS.WORKER_LOGS, REDIS_CHANNELS.WORKER_ACTIVITY).catch(() => {});
  logSubscriber.on('message', (_channel: string, message: string) => {
    try {
      const data = JSON.parse(message) as LogLine | ActivityEvent;
      if ('level' in data) {
        emitLogLine(data as LogLine);
      } else {
        emitActivityEvent(data as ActivityEvent);
      }
    } catch {}
  });

  // ── QueueEvents → Socket.IO job progress & activity events ───────
  const queuePairs = [
    { qEvents: scanQueueEvents,    queue: scanQueue,    stage: 'clone'       as const },
    { qEvents: cveQueueEvents,     queue: cveQueue,     stage: 'cve-scan'    as const },
    { qEvents: exploitQueueEvents, queue: exploitQueue, stage: 'exploit-gen' as const },
  ];

  for (const { qEvents, queue, stage } of queuePairs) {
    qEvents.on('active', async ({ jobId }) => {
      try {
        const job = await queue.getJob(jobId);
        const repoUrl   = (job?.data as { repoUrl?: string })?.repoUrl ?? '';
        const scanJobId = (job?.data as { scanJobId?: string })?.scanJobId ?? jobId;
        emitJobActive({ jobId, scanJobId, repoUrl, stage, progress: 0, status: 'active' });
        emitActivityEvent({
          id: jobId,
          timestamp: new Date().toISOString(),
          type: stage === 'clone' ? 'clone' : stage === 'cve-scan' ? 'scan' : 'exploit',
          message: `[${stage}] Job ${jobId} started`,
          repoUrl,
        });
      } catch {}
    });

    qEvents.on('completed', async ({ jobId }) => {
      try {
        const job = await queue.getJob(jobId);
        if (!job) return;
        const data = job.data as { scanJobId?: string; repoUrl?: string };
        const scanJobId = data.scanJobId ?? jobId;
        const repoUrl = data.repoUrl ?? '';
        const scanJob = await prisma.scanJob.findUnique({
          where: { id: scanJobId },
          select: { status: true },
        });
        if (!scanJob) return;

        const terminal = ['done', 'failed', 'skipped'];
        if (terminal.includes(scanJob.status)) {
          emitJobCompleted({
            jobId: scanJobId,
            scanJobId,
            repoUrl,
            stage,
            progress: 100,
            status: 'completed',
          });
          return;
        }

        // BullMQ step finished (clone/CVE/exploit) but pipeline scan still running
        const nextStage =
          stage === 'clone' ? 'cve-scan' as const : 'exploit-gen' as const;
        const progress = stage === 'clone' ? 40 : stage === 'cve-scan' ? 80 : 95;
        emitJobProgress({
          jobId: scanJobId,
          scanJobId,
          repoUrl,
          stage: nextStage,
          progress,
          status: 'active',
        });
      } catch {}
    });

    qEvents.on('failed', async ({ jobId, failedReason }) => {
      try {
        const job = await queue.getJob(jobId);
        if (!job) return;
        const data = job.data as { scanJobId?: string; repoUrl?: string };
        const scanJobId = data?.scanJobId ?? jobId;
        const repoUrl = data?.repoUrl ?? '';
        emitJobFailed({
          jobId: scanJobId,
          scanJobId,
          repoUrl,
          stage,
          progress: 0,
          status: 'failed',
          error: failedReason ?? 'unknown',
        });
        emitActivityEvent({
          id: jobId,
          timestamp: new Date().toISOString(),
          type: 'error',
          message: `[${stage}] Job ${jobId} failed: ${failedReason ?? 'unknown'}`,
        });
      } catch {}
    });
  }

  // Broadcast queue stats every 5s
  setInterval(async () => {
    try {
      const stats = await getQueueStats();
      emitQueueStats(stats);
    } catch {}
  }, 5000);

  // Broadcast dashboard stats every 15s
  setInterval(async () => {
    try {
      // Lightweight fetch
      const [scanSuccess, scanFailed, exploitDone, exploitPending] = await Promise.all([
        prisma.scanJob.count({ where: { status: 'done' } }),
        prisma.scanJob.count({ where: { status: 'failed' } }),
        prisma.vulnerability.count({ where: { exploitStatus: 'done' } }),
        prisma.vulnerability.count({ where: { exploitStatus: { in: ['pending', 'generating'] } } }),
      ]);
      emitDashboardStats({
        repos: { total: 0, queued: 0, scanning: 0, done: 0, failed: 0 },
        scans: { success: scanSuccess, failed: scanFailed, avgDurationMs: 0 },
        vulns: { critical: 0, high: 0, medium: 0, low: 0, dropped: 0, falsePositives: 0 },
        exploits: { generated: exploitDone, pending: exploitPending, failed: 0 },
      });
    } catch {}
  }, 15000);

  httpServer.listen(config.API_PORT, config.API_HOST as string, () => {
    console.log(`API listening on ${config.API_HOST}:${config.API_PORT}`);
  });

  const shutdown = async () => {
    await closeQueues();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
