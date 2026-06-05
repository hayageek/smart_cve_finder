import { Router } from 'express';
import { prisma } from '../db/client.js';
import { getQueueStats } from '../queues/index.js';

const router = Router();

router.get('/stats', async (_req, res) => {
  try {
    const [
      repoStats,
      vulnStats,
      secretStats,
      exploitStats,
      queueStats,
    ] = await Promise.all([
      prisma.repo.groupBy({ by: ['status'], _count: true }),
      prisma.vulnerability.groupBy({ by: ['severity', 'isFalsePositive', 'dropped'], _count: true }),
      prisma.secret.groupBy({ by: ['severity', 'isFalsePositive', 'dropped'], _count: true }),
      prisma.vulnerability.groupBy({ by: ['exploitStatus'], where: { exploitStatus: { not: null } }, _count: true }),
      getQueueStats(),
    ]);

    const repoMap = Object.fromEntries(repoStats.map((r) => [r.status, r._count]));

    const [scanSuccess, scanFailed, scanDurations] = await Promise.all([
      prisma.scanJob.count({ where: { status: 'done' } }),
      prisma.scanJob.count({ where: { status: 'failed' } }),
      prisma.scanJob.findMany({
        where: { status: 'done', startedAt: { not: null }, finishedAt: { not: null } },
        select: { startedAt: true, finishedAt: true },
        take: 100,
        orderBy: { finishedAt: 'desc' },
      }),
    ]);

    const avgDurationMs = scanDurations.length
      ? scanDurations.reduce((sum, j) => sum + (j.finishedAt!.getTime() - j.startedAt!.getTime()), 0) /
        scanDurations.length
      : 0;

    const vulnMap: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    let dropped = 0;
    let falsePositives = 0;
    for (const g of vulnStats) {
      if (g.isFalsePositive) { falsePositives += g._count; continue; }
      if (g.dropped)          { dropped += g._count; continue; }
      vulnMap[g.severity] = (vulnMap[g.severity] ?? 0) + g._count;
    }

    const secretMap: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    let secretsDropped = 0;
    let secretsFalsePositives = 0;
    for (const g of secretStats) {
      if (g.isFalsePositive) { secretsFalsePositives += g._count; continue; }
      if (g.dropped) { secretsDropped += g._count; continue; }
      secretMap[g.severity] = (secretMap[g.severity] ?? 0) + g._count;
    }

    const exploitMap = Object.fromEntries(exploitStats.map((e) => [e.exploitStatus, e._count]));

    res.json({
      repos: {
        total: Object.values(repoMap).reduce((a, b) => a + b, 0),
        queued: repoMap['queued'] ?? 0,
        scanning: (repoMap['cloning'] ?? 0) + (repoMap['scanning'] ?? 0) + (repoMap['exploiting'] ?? 0),
        done: repoMap['done'] ?? 0,
        failed: repoMap['failed'] ?? 0,
      },
      scans: { success: scanSuccess, failed: scanFailed, avgDurationMs: Math.round(avgDurationMs) },
      vulns: {
        critical: vulnMap['CRITICAL'] ?? 0,
        high: vulnMap['HIGH'] ?? 0,
        medium: vulnMap['MEDIUM'] ?? 0,
        low: vulnMap['LOW'] ?? 0,
        dropped,
        falsePositives,
      },
      secrets: {
        critical: secretMap['CRITICAL'] ?? 0,
        high: secretMap['HIGH'] ?? 0,
        medium: secretMap['MEDIUM'] ?? 0,
        low: secretMap['LOW'] ?? 0,
        dropped: secretsDropped,
        falsePositives: secretsFalsePositives,
      },
      exploits: {
        generated: exploitMap['done'] ?? 0,
        pending: (exploitMap['pending'] ?? 0) + (exploitMap['generating'] ?? 0),
        failed: exploitMap['failed'] ?? 0,
      },
      queues: queueStats,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
