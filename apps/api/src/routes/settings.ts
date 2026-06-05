import { Router } from 'express';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { prisma } from '../db/client.js';
import { config } from '../config.js';
import { resolveArtifactPath, type ArtifactFilename } from '../lib/artifact-files.js';
import { buildMcpConfigPayload } from '../lib/mcp-config.js';
import { scanQueue, exploitQueue } from '../queues/index.js';

const router = Router();

const MASKED = '***';
const SENSITIVE = [
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'DATABASE_URL',
  'GITHUB_TOKEN',
  'CURSOR_API_KEY',
];

router.get('/mcp-config', (_req, res) => {
  res.json(buildMcpConfigPayload());
});

router.get('/env', (_req, res) => {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    safe[k] = SENSITIVE.some((s) => k.includes(s)) ? MASKED : v;
  }
  res.json(safe);
});

const clearTargetSchema = z.object({
  target: z.enum([
    'repos',
    'scan-history',
    'vulnerabilities',
    'secrets',
    'exploits',
    'queue-scan',
    'queue-exploit',
    'everything',
  ]),
});

router.post('/clear', async (req, res) => {
  try {
    const { target } = clearTargetSchema.parse(req.body);

    switch (target) {
      case 'repos':
        await prisma.repo.deleteMany();
        break;
      case 'scan-history':
        await prisma.scanJob.deleteMany();
        await Promise.all([
          scanQueue.obliterate({ force: true }),
          exploitQueue.obliterate({ force: true }),
        ]);
        break;
      case 'vulnerabilities':
        await prisma.vulnerability.deleteMany();
        break;
      case 'secrets':
        await prisma.secret.deleteMany();
        break;
      case 'exploits': {
        const vulns = await prisma.vulnerability.findMany({
          where: { exploitStatus: { not: null } },
          select: { id: true, reportPath: true, exploitPath: true, payloadPath: true },
        });
        const names: ArtifactFilename[] = ['report.md', 'exploit.py', 'payload.py', 'run.sh', 'docker_run_script.sh'];
        for (const v of vulns) {
          const stored: Array<string | null> = [v.reportPath, v.exploitPath, v.payloadPath, null, null];
          for (let i = 0; i < names.length; i++) {
            const abs = resolveArtifactPath(v.id, names[i]!, stored[i] ?? null);
            if (abs) fs.rmSync(abs, { force: true });
          }
        }
        await prisma.vulnerability.updateMany({
          where: { exploitStatus: { not: null } },
          data: { exploitStatus: null, reportPath: null, exploitPath: null, payloadPath: null, exploitError: null, exploitAttempts: null },
        });
        break;
      }
      case 'queue-scan':
        await scanQueue.obliterate({ force: true });
        break;
      case 'queue-exploit':
        await exploitQueue.obliterate({ force: true });
        break;
      case 'everything':
        await prisma.$transaction([
          prisma.vulnerability.deleteMany(),
          prisma.secret.deleteMany(),
          prisma.scanJob.deleteMany(),
          prisma.repo.deleteMany(),
        ]);
        await Promise.all([
          scanQueue.obliterate({ force: true }),
          exploitQueue.obliterate({ force: true }),
        ]);
        break;
    }

    res.json({ ok: true, cleared: target });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/logs', (req, res) => {
  try {
    const logFile = path.join(config.LOGS_DIR, 'api.log');
    if (!fs.existsSync(logFile)) return res.status(404).json({ error: 'Log file not found' });
    const tail = req.query.tail ? parseInt(req.query.tail as string) : undefined;
    if (tail) {
      const content = fs.readFileSync(logFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      res.setHeader('Content-Type', 'text/plain');
      res.send(lines.slice(-tail).join('\n'));
    } else {
      res.download(logFile, 'api.log');
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
