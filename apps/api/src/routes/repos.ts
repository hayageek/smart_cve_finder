import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { prisma } from '../db/client.js';
import { enqueueScanJob, isRepoActivelyScanning, isRepoInScanPipeline } from '../lib/scan-queue.js';
import { emitActivityEvent } from '../sockets/index.js';
import { type PackageType } from '@secscan/shared';
import { z } from 'zod';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Helpers ───────────────────────────────────────────────────────

function detectGitProvider(url: string): string {
  if (url.includes('github.com')) return 'github';
  if (url.includes('bitbucket.org')) return 'bitbucket';
  if (url.includes('gitlab.com')) return 'gitlab';
  return 'other';
}

type ParsedEntry =
  | { packageType: 'git'; url: string; isPrivate: boolean }
  | { packageType: 'npm' | 'pip'; url: string; packageName: string; packageVersion?: string };

/**
 * Compute the canonical unique key (stored in the `url` column).
 *
 *   git repos  →  the clone URL as-is
 *                 e.g.  https://github.com/expressjs/express
 *
 *   packages   →  {type}:{name}  or  {type}:{name}@{version}
 *                 e.g.  npm:express
 *                       npm:express@4.17.21
 *                       pip:requests
 *                       pip:requests@2.31.0
 *
 * This ensures:
 *   - Two different npm packages from the same git repo are different rows.
 *   - The same package at different versions are different rows.
 *   - Duplicate imports of identical (type, name, version) are de-duplicated.
 */
function buildKey(type: 'git' | 'npm' | 'pip', nameOrUrl: string, version?: string): string {
  if (type === 'git') return nameOrUrl;
  return version ? `${type}:${nameOrUrl}@${version}` : `${type}:${nameOrUrl}`;
}

/**
 * Parse a single CSV row into a typed entry.
 *
 * Supported formats:
 *   https://github.com/org/repo[,public|private]   → git
 *   express,npm[,version]                           → npm package
 *   requests,pip[,version]                          → pip package
 */
function parseRow(row: string[]): ParsedEntry | null {
  const col0 = row[0]?.trim();
  if (!col0) return null;

  // Git URL
  if (col0.startsWith('http://') || col0.startsWith('https://')) {
    const visField = row.slice(1).find((v) =>
      ['public', 'private', 'internal'].includes(v.toLowerCase().trim()),
    );
    const isPrivate = visField
      ? ['private', 'internal'].includes(visField.toLowerCase().trim())
      : false;
    return { packageType: 'git', url: buildKey('git', col0), isPrivate };
  }

  // Package: name,type[,version]
  const pkgType = row[1]?.trim().toLowerCase() as PackageType | undefined;
  if (pkgType === 'npm' || pkgType === 'pip') {
    const rawVersion = row[2]?.trim();
    const packageVersion = rawVersion && rawVersion.toLowerCase() !== 'latest' ? rawVersion : undefined;
    const url = buildKey(pkgType, col0, packageVersion);
    return { packageType: pkgType, url, packageName: col0, packageVersion };
  }

  return null;
}

function entryToCreateData(entry: ParsedEntry) {
  if (entry.packageType === 'git') {
    return {
      url: entry.url,
      packageType: 'git' as const,
      provider: detectGitProvider(entry.url),
      isPrivate: entry.isPrivate,
      status: 'queued',
    };
  }
  return {
    url: entry.url,
    packageType: entry.packageType,
    packageName: entry.packageName,
    packageVersion: entry.packageVersion ?? null,
    provider: entry.packageType === 'npm' ? 'npm' : 'pypi',
    isPrivate: false, // public registries — confirmed on download
    status: 'queued',
  };
}

function entryToScanJobPayload(entry: ParsedEntry, scanJobId: string) {
  if (entry.packageType === 'git') {
    return { repoUrl: entry.url, packageType: 'git' as const, scanJobId };
  }
  return {
    repoUrl: entry.url,
    packageType: entry.packageType,
    packageName: entry.packageName,
    packageVersion: entry.packageVersion,
    scanJobId,
  };
}

// ── Routes ────────────────────────────────────────────────────────

router.post('/import/preview', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const text = req.file.buffer.toString('utf-8');
    const rows: string[][] = parse(text, { skip_empty_lines: true, trim: true, relax_column_count: true });
    const parsed = rows.map(parseRow).filter(Boolean) as ParsedEntry[];
    const urls = parsed.map((p) => p.url);
    const existing = await prisma.repo.findMany({
      where: { url: { in: urls } },
      select: { url: true, status: true },
    });
    const existingByUrl = new Map(existing.map((r) => [r.url, r.status]));

    const preview = parsed.map((entry) => {
      const status = existingByUrl.get(entry.url);
      const exists = status !== undefined;
      return {
        url: entry.url,
        packageType: entry.packageType,
        packageName: entry.packageType !== 'git' ? entry.packageName : undefined,
        packageVersion: entry.packageType !== 'git' ? entry.packageVersion : undefined,
        provider: entry.packageType === 'git'
          ? detectGitProvider(entry.url)
          : entry.packageType === 'npm' ? 'npm' : 'pypi',
        isPrivate: entry.packageType === 'git' ? entry.isPrivate : false,
        exists,
        inQueue: exists && isRepoInScanPipeline(status),
      };
    });

    res.json({ preview, total: parsed.length, duplicates: existing.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const text = req.file.buffer.toString('utf-8');
    const rows: string[][] = parse(text, { skip_empty_lines: true, trim: true, relax_column_count: true });
    const parsed = rows.map(parseRow).filter(Boolean) as ParsedEntry[];

    // Deduplicate within file
    const seen = new Set<string>();
    const unique = parsed.filter(({ url }) => seen.has(url) ? false : (seen.add(url), true));

    const existing = await prisma.repo.findMany({
      where: { url: { in: unique.map((p) => p.url) } },
      select: { url: true },
    });
    const existingSet = new Set(existing.map((r) => r.url));
    const newItems = unique.filter(({ url }) => !existingSet.has(url));

    const created = await Promise.all(
      newItems.map((entry) => prisma.repo.create({ data: entryToCreateData(entry) })),
    );

    let queued = 0;
    let skippedInQueue = 0;
    for (let i = 0; i < created.length; i++) {
      const repo = created[i];
      const entry = newItems[i];
      const scanJob = await prisma.scanJob.create({ data: { repoId: repo.id, status: 'pending' } });
      const result = await enqueueScanJob(repo.id, entryToScanJobPayload(entry, scanJob.id));
      if (!result.queued) {
        skippedInQueue++;
        continue;
      }
      queued++;
      emitActivityEvent({
        id: scanJob.id,
        timestamp: new Date().toISOString(),
        type: 'info',
        message: `Queued ${repo.packageName ?? repo.url} (${repo.packageType}) for scanning`,
        repoUrl: repo.url,
      });
    }

    res.json({
      queued,
      skipped: existing.length,
      skippedInQueue,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
  search: z.string().optional(),
  status: z.string().optional(),
  provider: z.string().optional(),
  packageType: z.enum(['all', 'git', 'npm', 'pip']).default('all'),
  visibility: z.enum(['public', 'private', 'all']).default('all'),
  sortBy: z.enum(['url', 'status', 'lastScannedAt', 'createdAt']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

router.get('/', async (req, res) => {
  try {
    const q = querySchema.parse(req.query);
    const where: Record<string, unknown> = {};
    if (q.search) {
      where.OR = [
        { url: { contains: q.search, mode: 'insensitive' } },
        { packageName: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    if (q.status) where.status = q.status;
    if (q.provider) where.provider = q.provider;
    if (q.packageType !== 'all') where.packageType = q.packageType;
    if (q.visibility === 'public') where.isPrivate = false;
    if (q.visibility === 'private') where.isPrivate = true;

    const [repos, total] = await Promise.all([
      prisma.repo.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { [q.sortBy]: q.sortDir },
        include: {
          scanJobs: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: {
              _count: { select: { vulnerabilities: true } },
              vulnerabilities: {
                select: { exploitStatus: true },
              },
            },
          },
        },
      }),
      prisma.repo.count({ where }),
    ]);

    const data = repos.map((r) => {
      const latestJob = r.scanJobs[0];
      const vulnCount = latestJob?._count.vulnerabilities ?? 0;
      const exploitCount = latestJob?.vulnerabilities.filter((v) => v.exploitStatus !== null).length ?? 0;
      return {
        id: r.id,
        url: r.url,
        repoUrl: r.repoUrl,
        packageName: r.packageName,
        packageType: r.packageType,
        packageVersion: r.packageVersion,
        provider: r.provider,
        isPrivate: r.isPrivate,
        status: r.status,
        lastScannedAt: r.lastScannedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        vulnCount,
        exploitCount,
      };
    });

    res.json({ data, total, page: q.page, pageSize: q.pageSize, totalPages: Math.ceil(total / q.pageSize) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.patch('/:id/visibility', async (req, res) => {
  try {
    const { isPrivate } = z.object({ isPrivate: z.boolean() }).parse(req.body);
    const updated = await prisma.repo.update({
      where: { id: req.params.id },
      data: { isPrivate },
      select: { id: true, isPrivate: true },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/:id/rescan', async (req, res) => {
  try {
    const repo = await prisma.repo.findUnique({ where: { id: req.params.id } });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    if (isRepoActivelyScanning(repo.status)) {
      return res.status(409).json({ error: 'Already scanning' });
    }

    const scanJob = await prisma.scanJob.create({ data: { repoId: repo.id, status: 'pending' } });
    const result = await enqueueScanJob(repo.id, {
      repoUrl: repo.url,
      packageType: (repo.packageType as PackageType) ?? 'git',
      packageName: repo.packageName ?? undefined,
      packageVersion: repo.packageVersion ?? undefined,
      scanJobId: scanJob.id,
      forceRescan: true,
    });

    if (!result.queued) {
      await prisma.scanJob.delete({ where: { id: scanJob.id } }).catch(() => undefined);
      return res.status(409).json({ error: 'Already queued or scanning' });
    }

    await prisma.repo.update({ where: { id: repo.id }, data: { status: 'queued' } });

    emitActivityEvent({
      id: scanJob.id,
      timestamp: new Date().toISOString(),
      type: 'info',
      message: `Re-scan triggered for ${repo.packageName ?? repo.url}`,
      repoUrl: repo.url,
    });

    res.json({ scanJobId: scanJob.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await prisma.repo.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/', async (req, res) => {
  try {
    const ids = req.body?.ids as string[] | undefined;
    if (ids?.length) {
      await prisma.repo.deleteMany({ where: { id: { in: ids } } });
    } else {
      await prisma.repo.deleteMany();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
