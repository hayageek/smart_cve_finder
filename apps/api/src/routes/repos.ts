import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { prisma } from '../db/client.js';
import { enqueueScanJob, isRepoActivelyScanning, isRepoInScanPipeline } from '../lib/scan-queue.js';
import {
  detectGitProvider,
  entryToCreateData,
  entryToScanJobPayload,
  parseCsvRow,
  parsedEntryToScanTarget,
  registryProvider,
  scanTargetToEntry,
  type ParsedEntry,
} from '../lib/repo-import.js';
import { enqueueRepoRescans, enqueueScans } from '../services/scans.js';
import { emitActivityEvent } from '../sockets/index.js';
import { evaluateRevisionGate } from '@secscan/source-revision';
import { config } from '../config.js';
import { REGISTRY_PACKAGE_TYPES, type PackageType, type ScanMode } from '@secscan/shared';
import { z } from 'zod';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const scanTargetSchema = z.union([
  z.object({ gitUrl: z.string().min(1), isPrivate: z.boolean().optional() }),
  z.object({
    packageName: z.string().min(1),
    packageType: z.enum(REGISTRY_PACKAGE_TYPES),
    packageVersion: z.string().optional(),
  }),
]);

function buildPreviewRow(
  entry: ParsedEntry,
  existing?: { status: string } | null,
) {
  return {
    url: entry.url,
    packageType: entry.packageType,
    packageName: entry.packageType !== 'git' ? entry.packageName : undefined,
    packageVersion: entry.packageType !== 'git' ? entry.packageVersion : undefined,
    provider: entry.packageType === 'git'
      ? detectGitProvider(entry.url)
      : registryProvider(entry.packageType),
    isPrivate: entry.packageType === 'git' ? entry.isPrivate : false,
    exists: !!existing,
    inQueue: existing ? isRepoInScanPipeline(existing.status) : false,
  };
}

async function previewEntries(parsed: ParsedEntry[]) {
  const urls = parsed.map((p) => p.url);
  const existing = await prisma.repo.findMany({
    where: { url: { in: urls } },
    select: { url: true, status: true },
  });
  const existingByUrl = new Map(existing.map((r) => [r.url, r.status]));
  const preview = parsed.map((entry) => {
    const status = existingByUrl.get(entry.url);
    return buildPreviewRow(entry, status !== undefined ? { status } : null);
  });
  return { preview, total: parsed.length, duplicates: existing.length };
}

// ── Routes ────────────────────────────────────────────────────────

router.post('/import/manual/preview', async (req, res) => {
  try {
    const target = scanTargetSchema.parse(req.body);
    const entry = scanTargetToEntry(target);
    if (!entry) {
      return res.status(400).json({
        error: 'Invalid entry — use a git URL (http/https) or a package name with type npm|pip|cargo|go|gem',
      });
    }
    const existing = await prisma.repo.findUnique({
      where: { url: entry.url },
      select: { status: true },
    });
    res.json({ preview: buildPreviewRow(entry, existing) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
    }
    res.status(500).json({ error: String(err) });
  }
});

const scanModeSchema = z.enum(['both', 'cve', 'secrets']).default('both');

router.post('/import/manual', async (req, res) => {
  try {
    const body = z.object({
      targets: z.array(scanTargetSchema).min(1),
      scanMode: scanModeSchema.optional(),
      force: z.boolean().optional(),
    }).parse(req.body);
    const result = await enqueueScans(body.targets, {
      scanMode: body.scanMode,
      force: body.force,
    });
    res.json({ queued: result.queued, skipped: result.skipped, results: result.results });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
    }
    res.status(500).json({ error: String(err) });
  }
});

router.post('/import/preview', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const text = req.file.buffer.toString('utf-8');
    const rows: string[][] = parse(text, { skip_empty_lines: true, trim: true, relax_column_count: true });
    const parsed = rows.map(parseCsvRow).filter(Boolean) as ParsedEntry[];
    res.json(await previewEntries(parsed));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const importBody = z.object({
      scanMode: scanModeSchema.optional(),
      force: z
        .string()
        .optional()
        .transform((v) => v === 'true'),
    }).parse(req.body ?? {});
    const scanMode = importBody.scanMode ?? 'both';
    const text = req.file.buffer.toString('utf-8');
    const rows: string[][] = parse(text, { skip_empty_lines: true, trim: true, relax_column_count: true });
    const parsed = rows.map(parseCsvRow).filter(Boolean) as ParsedEntry[];

    const seen = new Set<string>();
    const unique = parsed.filter(({ url }) => seen.has(url) ? false : (seen.add(url), true));

    const result = await enqueueScans(unique.map(parsedEntryToScanTarget), {
      scanMode,
      force: importBody.force,
    });
    console.info(
      `[revision-gate] csv import: total=${unique.length} queued=${result.queued} skipped=${result.skipped}`,
    );

    res.json({
      queued: result.queued,
      skipped: result.skipped,
      results: result.results,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const repoFilterSchema = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
  provider: z.string().optional(),
  packageType: z.enum(['all', 'git', 'npm', 'pip', 'cargo', 'go', 'gem']).default('all'),
  visibility: z.enum(['public', 'private', 'all']).default('all'),
});

function buildRepoWhere(filters: z.infer<typeof repoFilterSchema>): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (filters.search) {
    where.OR = [
      { url: { contains: filters.search, mode: 'insensitive' } },
      { packageName: { contains: filters.search, mode: 'insensitive' } },
    ];
  }
  if (filters.status) where.status = filters.status;
  if (filters.provider) where.provider = filters.provider;
  if (filters.packageType !== 'all') where.packageType = filters.packageType;
  if (filters.visibility === 'public') where.isPrivate = false;
  if (filters.visibility === 'private') where.isPrivate = true;
  return where;
}

const querySchema = repoFilterSchema.extend({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
  sortBy: z.enum(['url', 'status', 'lastScannedAt', 'createdAt']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

router.get('/', async (req, res) => {
  try {
    const q = querySchema.parse(req.query);
    const where = buildRepoWhere(q);

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

router.post('/rescan', async (req, res) => {
  try {
    const body = z.object({
      ids: z.array(z.string().min(1)).min(1),
      scanMode: scanModeSchema.optional(),
      force: z.boolean().optional(),
    }).parse(req.body);

    const result = await enqueueRepoRescans(body.ids, {
      scanMode: body.scanMode,
      force: body.force,
    });

    console.info(
      `[revision-gate] bulk rescan: total=${body.ids.length} queued=${result.queued} skipped=${result.skipped}`,
    );

    res.json({
      total: body.ids.length,
      queued: result.queued,
      skipped: result.skipped,
      results: result.results,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
    }
    res.status(500).json({ error: String(err) });
  }
});

router.post('/rescan-all', async (req, res) => {
  try {
    const body = z.object({
      scanMode: scanModeSchema.optional(),
      force: z.boolean().optional(),
      /** When true, apply list filters below; otherwise queue every repo in the database. */
      useFilters: z.boolean().optional(),
      search: z.string().optional(),
      status: z.string().optional(),
      provider: z.string().optional(),
      packageType: repoFilterSchema.shape.packageType.optional(),
      visibility: repoFilterSchema.shape.visibility.optional(),
    }).parse(req.body);

    const where = body.useFilters
      ? buildRepoWhere({
          search: body.search,
          status: body.status,
          provider: body.provider,
          packageType: body.packageType ?? 'all',
          visibility: body.visibility ?? 'all',
        })
      : {};

    const repos = await prisma.repo.findMany({
      where,
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });

    const result = await enqueueRepoRescans(
      repos.map((r) => r.id),
      { scanMode: body.scanMode, force: body.force },
    );

    console.info(
      `[revision-gate] rescan-all: total=${repos.length} queued=${result.queued} skipped=${result.skipped} useFilters=${!!body.useFilters}`,
    );

    res.json({
      total: repos.length,
      queued: result.queued,
      skipped: result.skipped,
      results: result.results,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors.map((e) => e.message).join('; ') });
    }
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

    const body = z.object({
      scanMode: scanModeSchema.optional(),
      /** Bypass revision check and re-scan even when commit/version unchanged. */
      force: z.boolean().optional(),
    }).parse(req.body ?? {});
    const scanMode = body.scanMode ?? 'both';
    const force = body.force ?? false;

    if (!force) {
      const gate = await evaluateRevisionGate(
        {
          status: repo.status,
          packageType: repo.packageType,
          url: repo.url,
          packageName: repo.packageName,
          packageVersion: repo.packageVersion,
          lastScannedRevision: repo.lastScannedRevision,
          lastCveScannedRevision: repo.lastCveScannedRevision,
          lastSecretScannedRevision: repo.lastSecretScannedRevision,
        },
        { force: false, scanMode, githubToken: config.GITHUB_TOKEN },
      );
      console.info(`[revision-gate] rescan: ${gate.log}`);
      if (gate.action === 'skip') {
        emitActivityEvent({
          id: repo.id,
          timestamp: new Date().toISOString(),
          type: 'info',
          message: `[revision-gate] ${gate.message} — ${repo.packageName ?? repo.url}`,
          repoUrl: repo.url,
        });
        return res.json({ skipped: true, reason: 'unchanged-revision', message: gate.message });
      }
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
