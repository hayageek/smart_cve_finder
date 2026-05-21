import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import type { PackageType } from '@secscan/shared';
import { enqueueScanJob } from '../lib/scan-queue.js';
import { scanQueue, cveQueue, exploitQueue, getQueueStats } from '../queues/index.js';

const router = Router();

/** Re-add BullMQ jobs for scan rows stuck in pending with no bullJobId (e.g. after import bug). */
router.post('/requeue-pending', async (_req, res) => {
  try {
    const pending = await prisma.scanJob.findMany({
      where: { status: 'pending', bullJobId: null },
      include: { repo: true },
    });

    let queued = 0;
    let skipped = 0;
    for (const job of pending) {
      const repo = job.repo;
      const result = await enqueueScanJob(repo.id, {
        repoUrl: repo.url,
        packageType: (repo.packageType as PackageType) ?? 'git',
        packageName: repo.packageName ?? undefined,
        packageVersion: repo.packageVersion ?? undefined,
        scanJobId: job.id,
      });
      if (result.queued) queued++;
      else skipped++;
    }

    res.json({ queued, skipped, total: pending.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/queue-stats', async (_req, res) => {
  try {
    const stats = await getQueueStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/active-jobs', async (_req, res) => {
  try {
    const [scanJobs, cveJobs, exploitJobs] = await Promise.all([
      scanQueue.getActive(),
      cveQueue.getActive(),
      exploitQueue.getActive(),
    ]);
    res.json({ scan: scanJobs, cve: cveJobs, exploit: exploitJobs });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/failed-jobs', async (_req, res) => {
  try {
    const [scanJobs, cveJobs, exploitJobs] = await Promise.all([
      scanQueue.getFailed(),
      cveQueue.getFailed(),
      exploitQueue.getFailed(),
    ]);
    res.json({ scan: scanJobs, cve: cveJobs, exploit: exploitJobs });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/failed/clear', async (_req, res) => {
  try {
    await Promise.all([
      scanQueue.clean(0, 100, 'failed'),
      cveQueue.clean(0, 100, 'failed'),
      exploitQueue.clean(0, 100, 'failed'),
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/failed/:queueName/:jobId/retry', async (req, res) => {
  try {
    const q = { [scanQueue.name]: scanQueue, [cveQueue.name]: cveQueue, [exploitQueue.name]: exploitQueue }[
      req.params.queueName
    ];
    if (!q) return res.status(404).json({ error: 'Queue not found' });
    const job = await q.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    await job.retry();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const historySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
  status: z.string().optional(),
  repoUrl: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

router.get('/history', async (req, res) => {
  try {
    const q = historySchema.parse(req.query);
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.repoUrl) where.repo = { url: { contains: q.repoUrl, mode: 'insensitive' } };
    if (q.dateFrom || q.dateTo) {
      where.createdAt = {
        ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}),
        ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}),
      };
    }

    const [jobs, total] = await Promise.all([
      prisma.scanJob.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          repo: { select: { url: true, provider: true } },
          _count: { select: { vulnerabilities: true } },
          vulnerabilities: {
            select: { exploitStatus: true },
          },
        },
      }),
      prisma.scanJob.count({ where }),
    ]);

    const data = jobs.map((j) => ({
      id: j.id,
      repoId: j.repoId,
      repoUrl: j.repo.url,
      provider: j.repo.provider,
      bullJobId: j.bullJobId,
      status: j.status,
      stage: j.stage,
      startedAt: j.startedAt?.toISOString() ?? null,
      finishedAt: j.finishedAt?.toISOString() ?? null,
      durationMs:
        j.startedAt && j.finishedAt ? j.finishedAt.getTime() - j.startedAt.getTime() : null,
      error: j.error,
      createdAt: j.createdAt.toISOString(),
      vulnCount: j._count.vulnerabilities,
      exploitCount: j.vulnerabilities.filter((v) => v.exploitStatus !== null).length,
    }));

    res.json({ data, total, page: q.page, pageSize: q.pageSize, totalPages: Math.ceil(total / q.pageSize) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const job = await prisma.scanJob.findUnique({
      where: { id: req.params.id },
      include: {
        repo: true,
        vulnerabilities: {
          select: { id: true, severity: true, cwe: true, exploitStatus: true },
        },
      },
    });
    if (!job) return res.status(404).json({ error: 'Not found' });

    const bySeverity = job.vulnerabilities.reduce<Record<string, number>>((acc, v) => {
      acc[v.severity] = (acc[v.severity] ?? 0) + 1;
      return acc;
    }, {});

    res.json({ ...job, bySeverity });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/history', async (_req, res) => {
  try {
    await prisma.scanJob.deleteMany();
    await Promise.all([
      scanQueue.obliterate({ force: true }),
      cveQueue.obliterate({ force: true }),
      exploitQueue.obliterate({ force: true }),
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
