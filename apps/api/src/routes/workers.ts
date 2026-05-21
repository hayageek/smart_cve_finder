import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { config } from '../config.js';
import { scanQueue, cveQueue, exploitQueue, getQueueStats } from '../queues/index.js';
import { emitQueueStats } from '../sockets/index.js';
import { readWorkerLogTail } from '../lib/parseWorkerLogs.js';

const router = Router();

router.get('/config', async (_req, res) => {
  try {
    const cfg = await prisma.workerConfig.findFirst();
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const configSchema = z.object({
  scannerConcurrency: z.coerce.number().min(1).max(50).optional(),
  exploitConcurrency: z.coerce.number().min(1).max(50).optional(),
  exploitMinSeverity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
  exploitIncludeDropped: z.boolean().optional(),
  dedupWindowHours: z.coerce.number().min(0).optional(),
  workspaceCleanupHours: z.coerce.number().min(0).optional(),
  notifyWebhookUrl: z.string().url().nullable().optional(),
  notifyOnCritical: z.boolean().optional(),
  notifyOnScanComplete: z.boolean().optional(),
});

router.patch('/config', async (req, res) => {
  try {
    const data = configSchema.parse(req.body);
    const cfg = await prisma.workerConfig.findFirst();
    if (!cfg) return res.status(404).json({ error: 'Config not found' });

    const updated = await prisma.workerConfig.update({
      where: { id: cfg.id },
      data,
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/scanner/pause', async (_req, res) => {
  try {
    await Promise.all([scanQueue.pause(), cveQueue.pause()]);
    const stats = await getQueueStats();
    emitQueueStats(stats);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/scanner/resume', async (_req, res) => {
  try {
    await Promise.all([scanQueue.resume(), cveQueue.resume()]);
    const stats = await getQueueStats();
    emitQueueStats(stats);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/scanner/drain', async (_req, res) => {
  try {
    await Promise.all([scanQueue.drain(), cveQueue.drain()]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/exploit/pause', async (_req, res) => {
  try {
    await exploitQueue.pause();
    const stats = await getQueueStats();
    emitQueueStats(stats);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/exploit/resume', async (_req, res) => {
  try {
    await exploitQueue.resume();
    const stats = await getQueueStats();
    emitQueueStats(stats);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/exploit/drain', async (_req, res) => {
  try {
    await exploitQueue.drain();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const SCAN_PIPELINE_ACTIVE = ['pending', 'cloning', 'scanning', 'exploiting', 'exploit-gen'] as const;

router.get('/queue-stats', async (_req, res) => {
  try {
    const [scanPaused, cvePaused, exploitPaused, stats, scanJobGroups] = await Promise.all([
      scanQueue.isPaused(),
      cveQueue.isPaused(),
      exploitQueue.isPaused(),
      getQueueStats(),
      prisma.scanJob.groupBy({ by: ['status'], _count: true }),
    ]);
    const scanJobMap = Object.fromEntries(scanJobGroups.map((g) => [g.status, g._count]));
    res.json({
      stats,
      paused: { scanner: scanPaused || cvePaused, exploit: exploitPaused },
      pipeline: {
        inProgress: SCAN_PIPELINE_ACTIVE.reduce((sum, s) => sum + (scanJobMap[s] ?? 0), 0),
        done: scanJobMap['done'] ?? 0,
        failed: (scanJobMap['failed'] ?? 0) + (scanJobMap['skipped'] ?? 0),
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const logsQuerySchema = z.object({
  tail: z.coerce.number().min(1).max(5000).default(500),
});

router.get('/logs', (req, res) => {
  try {
    const q = logsQuerySchema.parse(req.query);
    const lines = readWorkerLogTail(config.LOGS_DIR, q.tail);
    res.json({ lines, total: lines.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/logs/download', (_req, res) => {
  try {
    const logFile = path.join(config.LOGS_DIR, 'workers.log');
    if (!fs.existsSync(logFile)) return res.status(404).json({ error: 'Log file not found' });
    res.download(logFile, 'workers.log');
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/logs', (_req, res) => {
  try {
    const logFile = path.join(config.LOGS_DIR, 'workers.log');
    if (fs.existsSync(logFile)) fs.writeFileSync(logFile, '');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/queues/:name/clear', async (req, res) => {
  try {
    const q = { 'repo-scan-queue': scanQueue, 'cve-scan-queue': cveQueue, 'exploit-gen-queue': exploitQueue }[
      req.params.name
    ];
    if (!q) return res.status(404).json({ error: 'Queue not found' });
    await q.obliterate({ force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
