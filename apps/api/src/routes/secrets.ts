import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';

const router = Router();

const secretQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
  severity: z.string().optional(),
  ruleId: z.string().optional(),
  secretType: z.string().optional(),
  verifyStatus: z.string().optional(),
  repoUrl: z.string().optional(),
  value: z.string().optional(),
  falsePositive: z.enum(['yes', 'no']).optional(),
  dropped: z.enum(['yes', 'no', 'all']).default('no'),
  sortBy: z.enum(['severity', 'createdAt', 'verifyStatus']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

const safeFilenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => !s.includes('/') && !s.includes('\\'), 'invalid filename');

const safeExtensionSchema = z
  .string()
  .min(2)
  .max(32)
  .refine((s) => s.startsWith('.') && !s.includes('/') && !s.includes('\\'), 'invalid extension');

function secretFilenameWhere(filename: string) {
  return {
    OR: [
      { path: { endsWith: `/${filename}`, mode: 'insensitive' as const } },
      { path: { equals: filename, mode: 'insensitive' as const } },
    ],
  };
}

function secretExtensionWhere(extension: string) {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return { path: { endsWith: ext, mode: 'insensitive' as const } };
}

const droppedQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
  severity: z.string().optional(),
  dropReason: z.string().optional(),
  ruleId: z.string().optional(),
  verifyStatus: z.string().optional(),
  repoUrl: z.string().optional(),
  value: z.string().optional(),
});

function secretValueWhere(value: string) {
  return { redactedValue: { contains: value, mode: 'insensitive' as const } };
}

function repoGhFields(repo: {
  githubStars: number | null;
  githubForks: number | null;
  privateVulnerabilityReportingEnabled: boolean | null;
}) {
  return {
    githubStars: repo.githubStars,
    githubForks: repo.githubForks,
    privateVulnerabilityReportingEnabled: repo.privateVulnerabilityReportingEnabled,
  };
}

const repoSelect = {
  url: true,
  repoUrl: true,
  tarballUrl: true,
  githubStars: true,
  githubForks: true,
  privateVulnerabilityReportingEnabled: true,
} as const;

function mapSecretRow(
  s: {
    id: string;
    scanJobId: string;
    ruleId: string;
    path: string;
    lineStart: number;
    lineEnd: number | null;
    severity: string;
    secretType: string | null;
    redactedValue: string | null;
    verifyStatus: string;
    detectorName: string | null;
    message: string | null;
    metadataJson: unknown;
    isFalsePositive: boolean;
    dropped: boolean;
    dropReason: string | null;
    dropEvidence: string | null;
    createdAt: Date;
    scanJob: { repo: typeof repoSelect extends infer _ ? {
      url: string;
      repoUrl: string | null;
      tarballUrl: string | null;
      githubStars: number | null;
      githubForks: number | null;
      privateVulnerabilityReportingEnabled: boolean | null;
    } : never };
  },
) {
  return {
    id: s.id,
    scanJobId: s.scanJobId,
    repoUrl: s.scanJob.repo.url,
    packageRepoUrl: s.scanJob.repo.repoUrl,
    packageTarballUrl: s.scanJob.repo.tarballUrl,
    ruleId: s.ruleId,
    path: s.path,
    lineStart: s.lineStart,
    lineEnd: s.lineEnd,
    severity: s.severity,
    secretType: s.secretType,
    redactedValue: s.redactedValue,
    verifyStatus: s.verifyStatus,
    detectorName: s.detectorName,
    message: s.message,
    metadataJson: s.metadataJson as Record<string, unknown> | null,
    isFalsePositive: s.isFalsePositive,
    dropped: s.dropped,
    dropReason: s.dropReason,
    dropEvidence: s.dropEvidence,
    createdAt: s.createdAt.toISOString(),
    ...repoGhFields(s.scanJob.repo),
  };
}

router.get('/', async (req, res) => {
  try {
    const q = secretQuerySchema.parse(req.query);
    const where: Record<string, unknown> = {};

    if (q.dropped === 'no') where.dropped = false;
    if (q.dropped === 'yes') where.dropped = true;
    if (q.severity) where.severity = { in: q.severity.split(',') };
    if (q.ruleId) where.ruleId = { contains: q.ruleId, mode: 'insensitive' };
    if (q.secretType) where.secretType = { contains: q.secretType, mode: 'insensitive' };
    if (q.verifyStatus) where.verifyStatus = { in: q.verifyStatus.split(',') };
    if (q.falsePositive === 'yes') where.isFalsePositive = true;
    if (q.falsePositive === 'no') where.isFalsePositive = false;
    if (q.repoUrl) {
      where.scanJob = { repo: { url: { contains: q.repoUrl, mode: 'insensitive' } } };
    }
    if (q.value) Object.assign(where, secretValueWhere(q.value));

    const orderBy =
      q.sortBy === 'severity'
        ? { severityRank: q.sortDir }
        : { [q.sortBy]: q.sortDir };

    const [rows, total] = await Promise.all([
      prisma.secret.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy,
        include: { scanJob: { include: { repo: { select: repoSelect } } } },
      }),
      prisma.secret.count({ where }),
    ]);

    res.json({
      data: rows.map(mapSecretRow),
      total,
      page: q.page,
      pageSize: q.pageSize,
      totalPages: Math.ceil(total / q.pageSize),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/dropped', async (req, res) => {
  try {
    const q = droppedQuerySchema.parse(req.query);
    const where: Record<string, unknown> = { dropped: true };
    if (q.severity) where.severity = { in: q.severity.split(',') };
    if (q.dropReason) where.dropReason = q.dropReason;
    if (q.ruleId) where.ruleId = { contains: q.ruleId, mode: 'insensitive' };
    if (q.verifyStatus) where.verifyStatus = { in: q.verifyStatus.split(',') };
    if (q.repoUrl) {
      where.scanJob = { repo: { url: { contains: q.repoUrl, mode: 'insensitive' } } };
    }
    if (q.value) Object.assign(where, secretValueWhere(q.value));

    const [rows, total] = await Promise.all([
      prisma.secret.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { scanJob: { include: { repo: { select: repoSelect } } } },
      }),
      prisma.secret.count({ where }),
    ]);

    res.json({
      data: rows.map(mapSecretRow),
      total,
      page: q.page,
      pageSize: q.pageSize,
      totalPages: Math.ceil(total / q.pageSize),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/by-rule', async (_req, res) => {
  try {
    const [confirmedGroups, droppedGroups] = await Promise.all([
      prisma.secret.groupBy({
        by: ['ruleId'],
        where: { dropped: false },
        _count: { _all: true },
      }),
      prisma.secret.groupBy({
        by: ['ruleId'],
        where: { dropped: true },
        _count: { _all: true },
      }),
    ]);

    const mapGroups = (groups: { ruleId: string; _count: { _all: number } }[]) =>
      groups
        .map((g) => ({ ruleId: g.ruleId, count: g._count._all }))
        .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));

    res.json({
      confirmed: mapGroups(confirmedGroups),
      dropped: mapGroups(droppedGroups),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/by-value/count', async (req, res) => {
  try {
    const { value } = z.object({ value: z.string().min(1) }).parse(req.body);
    const count = await prisma.secret.count({ where: { redactedValue: value } });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/by-value', async (req, res) => {
  try {
    const { value } = z.object({ value: z.string().min(1) }).parse(req.body);
    const { count } = await prisma.secret.deleteMany({ where: { redactedValue: value } });
    res.json({ ok: true, deleted: count });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/by-filename/count', async (req, res) => {
  try {
    const { filename } = z.object({ filename: safeFilenameSchema }).parse(req.body);
    const count = await prisma.secret.count({ where: secretFilenameWhere(filename) });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/by-filename', async (req, res) => {
  try {
    const { filename } = z.object({ filename: safeFilenameSchema }).parse(req.body);
    const { count } = await prisma.secret.deleteMany({ where: secretFilenameWhere(filename) });
    res.json({ ok: true, deleted: count });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/by-extension/count', async (req, res) => {
  try {
    const { extension } = z.object({ extension: safeExtensionSchema }).parse(req.body);
    const count = await prisma.secret.count({ where: secretExtensionWhere(extension) });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/by-extension', async (req, res) => {
  try {
    const { extension } = z.object({ extension: safeExtensionSchema }).parse(req.body);
    const { count } = await prisma.secret.deleteMany({ where: secretExtensionWhere(extension) });
    res.json({ ok: true, deleted: count });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await prisma.secret.findUnique({
      where: { id: req.params.id },
      include: { scanJob: { include: { repo: { select: repoSelect } } } },
    });
    if (!row) return res.status(404).json({ error: 'Secret not found' });
    res.json(mapSecretRow(row));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.patch('/:id/false-positive', async (req, res) => {
  try {
    const { value } = z.object({ value: z.boolean() }).parse(req.body);
    const updated = await prisma.secret.update({
      where: { id: req.params.id },
      data: { isFalsePositive: value },
      select: { id: true, isFalsePositive: true },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/dropped/:id/promote', async (req, res) => {
  try {
    const updated = await prisma.secret.update({
      where: { id: req.params.id },
      data: { dropped: false, dropReason: null, dropEvidence: null },
    });
    res.json({ ok: true, id: updated.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/confirmed', async (_req, res) => {
  try {
    const { count } = await prisma.secret.deleteMany({ where: { dropped: false } });
    res.json({ ok: true, deleted: count });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/dropped', async (req, res) => {
  try {
    const body = z.object({ ids: z.array(z.string()).optional() }).parse(req.body ?? {});
    const where: { dropped: true; id?: { in: string[] } } = { dropped: true };
    if (body.ids?.length) where.id = { in: body.ids };
    const { count } = await prisma.secret.deleteMany({ where });
    res.json({ ok: true, deleted: count });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/bulk', async (req, res) => {
  try {
    const { ids } = z.object({ ids: z.array(z.string()).min(1) }).parse(req.body);
    const { count } = await prisma.secret.deleteMany({ where: { id: { in: ids } } });
    res.json({ ok: true, deleted: count });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await prisma.secret.delete({ where: { id: req.params.id } });
    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/', async (req, res) => {
  try {
    const { count } = await prisma.secret.deleteMany();
    res.json({ ok: true, deleted: count });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
