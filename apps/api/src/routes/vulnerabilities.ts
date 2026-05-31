import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { exploitQueue } from '../queues/index.js';
import { emitActivityEvent } from '../sockets/index.js';
import {
  saveFindingArtifacts,
  saveFindingArtifactBuffers,
  deleteFindingArtifacts,
} from '../services/artifacts.js';
import { getNextUnexploitedFinding, setFindingExploitable } from '../services/findings.js';
import type { PackageType } from '@secscan/shared';

const artifactUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

const router = Router();

// ── List / filter ─────────────────────────────────────────────────

const vulnQuerySchema = z.object({
  page:           z.coerce.number().min(1).default(1),
  pageSize:       z.coerce.number().min(1).max(100).default(20),
  severity:       z.string().optional(),
  cwe:            z.string().optional(),
  vulnType:       z.string().optional(),
  repoUrl:        z.string().optional(),
  org:            z.string().optional(),
  exploited:      z.enum(['yes', 'no']).optional(),
  /** Successful exploit generated (exploitStatus === done). */
  exploitable:    z.enum(['yes', 'no']).optional(),
  falsePositive:  z.enum(['yes', 'no']).optional(),
  /** CVE reported / workflow complete */
  cveReported:    z.enum(['yes', 'no']).optional(),
  dropped:        z.enum(['yes', 'no', 'all']).default('no'),
  exploitStatus:  z.string().optional(),
  dateFrom:       z.string().optional(),
  dateTo:         z.string().optional(),
  sortBy:         z.enum(['severity', 'cwe', 'createdAt', 'cvssScore', 'stars']).default('createdAt'),
  sortDir:        z.enum(['asc', 'desc']).default('desc'),
  /** GitHub PVR filter: enabled | disabled | unknown */
  pvr:            z.enum(['enabled', 'disabled', 'unknown']).optional(),
});

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

router.get('/', async (req, res) => {
  try {
    const q = vulnQuerySchema.parse(req.query);
    const where: Record<string, unknown> = {};

    // dropped filter — default hides dropped findings
    if (q.dropped === 'no')  where.dropped = false;
    if (q.dropped === 'yes') where.dropped = true;
    // 'all' → no filter on dropped

    if (q.severity)      where.severity = { in: q.severity.split(',') };
    if (q.cwe)           where.cwe = { contains: q.cwe, mode: 'insensitive' };
    if (q.vulnType)      where.vulnType = { contains: q.vulnType, mode: 'insensitive' };
    if (q.falsePositive === 'yes') where.isFalsePositive = true;
    if (q.falsePositive === 'no')  where.isFalsePositive = false;
    if (q.cveReported === 'yes') where.cveReported = true;
    if (q.cveReported === 'no')  where.cveReported = false;
    if (q.exploited === 'yes') where.exploitStatus = { not: null };
    if (q.exploited === 'no')  where.exploitStatus = null;
    if (q.exploitable === 'yes') where.exploitStatus = 'done';
    if (q.exploitable === 'no') where.exploitStatus = { not: 'done' };
    // Special values: 'none' → never attempted (null), 'in_progress' → pending or generating
    if (q.exploitStatus === 'none') {
      where.exploitStatus = null;
    } else if (q.exploitStatus === 'in_progress') {
      where.exploitStatus = { in: ['pending', 'generating'] };
    } else if (q.exploitStatus) {
      where.exploitStatus = q.exploitStatus;
    }
    if (q.dateFrom || q.dateTo) {
      where.createdAt = {
        ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}),
        ...(q.dateTo   ? { lte: new Date(q.dateTo) }   : {}),
      };
    }
    const repoClauses: Record<string, unknown>[] = [];
    if (q.repoUrl) repoClauses.push({ url: { contains: q.repoUrl, mode: 'insensitive' } });
    if (q.org) repoClauses.push({ url: { contains: `/${q.org}/`, mode: 'insensitive' } });
    if (q.pvr === 'enabled') repoClauses.push({ privateVulnerabilityReportingEnabled: true });
    if (q.pvr === 'disabled') repoClauses.push({ privateVulnerabilityReportingEnabled: false });
    if (q.pvr === 'unknown') repoClauses.push({ privateVulnerabilityReportingEnabled: null });
    if (repoClauses.length === 1) {
      where.scanJob = { repo: repoClauses[0] };
    } else if (repoClauses.length > 1) {
      where.scanJob = { repo: { AND: repoClauses } };
    }

    const repoSelect = {
      url: true,
      repoUrl: true,
      tarballUrl: true,
      githubStars: true,
      githubForks: true,
      privateVulnerabilityReportingEnabled: true,
    } as const;

    const orderBy =
      q.sortBy === 'stars'
        ? { scanJob: { repo: { githubStars: q.sortDir } } }
        : { [q.sortBy]: q.sortDir };

    const [vulns, total] = await Promise.all([
      prisma.vulnerability.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy,
        include: { scanJob: { include: { repo: { select: repoSelect } } } },
      }),
      prisma.vulnerability.count({ where }),
    ]);

    const data = vulns.map((v) => ({
      id:             v.id,
      scanJobId:      v.scanJobId,
      repoUrl:        v.scanJob.repo.url,
      packageRepoUrl: v.scanJob.repo.repoUrl,
      packageTarballUrl: v.scanJob.repo.tarballUrl,
      checkId:        v.checkId,
      path:           v.path,
      lineStart:      v.lineStart,
      lineEnd:        v.lineEnd,
      severity:       v.severity,
      cwe:            v.cwe,
      vulnType:       v.vulnType,
      message:        v.message,
      metadataJson:   v.metadataJson,
      isFalsePositive: v.isFalsePositive,
      cveReported:    v.cveReported,
      cveReportedAt:  v.cveReportedAt?.toISOString() ?? null,
      cvssScore:      v.cvssScore,
      dropped:        v.dropped,
      dropReason:     v.dropReason,
      dropEvidence:   v.dropEvidence,
      exploitStatus:  v.exploitStatus,
      reportPath:     v.reportPath,
      exploitPath:    v.exploitPath,
      payloadPath:    v.payloadPath,
      exploitError:   v.exploitError,
      exploitAttempts: v.exploitAttempts,
      createdAt:      v.createdAt.toISOString(),
      ...repoGhFields(v.scanJob.repo),
    }));

    res.json({ data, total, page: q.page, pageSize: q.pageSize, totalPages: Math.ceil(total / q.pageSize) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Dropped findings (must be registered before /:id) ─────────────

const droppedQuerySchema = z.object({
  page:       z.coerce.number().min(1).default(1),
  pageSize:   z.coerce.number().min(1).max(100).default(20),
  dropReason: z.string().optional(),
  cwe:        z.string().optional(),
  vulnType:   z.string().optional(),
  repoUrl:    z.string().optional(),
});

type VulnWithRepo = Awaited<ReturnType<typeof prisma.vulnerability.findMany<{
  include: { scanJob: { include: { repo: {
    select: {
      url: true;
      repoUrl: true;
      tarballUrl: true;
      githubStars: true;
      githubForks: true;
      privateVulnerabilityReportingEnabled: true;
    };
  } } } }
}>>>[number];

function mapVulnRow(v: VulnWithRepo) {
  return {
    id:              v.id,
    scanJobId:       v.scanJobId,
    repoUrl:         v.scanJob.repo.url,
    packageRepoUrl:  v.scanJob.repo.repoUrl,
    packageTarballUrl: v.scanJob.repo.tarballUrl,
    ...repoGhFields(v.scanJob.repo),
    checkId:         v.checkId,
    path:            v.path,
    lineStart:       v.lineStart,
    lineEnd:         v.lineEnd,
    severity:        v.severity,
    cwe:             v.cwe,
    vulnType:        v.vulnType,
    message:         v.message,
    metadataJson:    v.metadataJson,
    isFalsePositive: v.isFalsePositive,
    cveReported:     v.cveReported,
    cveReportedAt:   v.cveReportedAt?.toISOString() ?? null,
    cvssScore:       v.cvssScore,
    dropped:         v.dropped,
    dropReason:      v.dropReason,
    dropEvidence:    v.dropEvidence,
    exploitStatus:   v.exploitStatus,
    reportPath:      v.reportPath,
    exploitPath:     v.exploitPath,
    payloadPath:     v.payloadPath,
    exploitError:    v.exploitError,
    exploitAttempts: v.exploitAttempts,
    createdAt:       v.createdAt.toISOString(),
  };
}

router.get('/dropped', async (req, res) => {
  try {
    const q = droppedQuerySchema.parse(req.query);
    const where: Record<string, unknown> = { dropped: true };
    if (q.dropReason) where.dropReason = q.dropReason;
    if (q.cwe)        where.cwe = { contains: q.cwe, mode: 'insensitive' };
    if (q.vulnType)   where.vulnType = { contains: q.vulnType, mode: 'insensitive' };
    if (q.repoUrl) {
      where.scanJob = { repo: { url: { contains: q.repoUrl, mode: 'insensitive' } } };
    }

    const [vulns, total] = await Promise.all([
      prisma.vulnerability.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          scanJob: {
            include: {
              repo: {
                select: {
                  url: true,
                  repoUrl: true,
                  tarballUrl: true,
                  githubStars: true,
                  githubForks: true,
                  privateVulnerabilityReportingEnabled: true,
                },
              },
            },
          },
        },
      }),
      prisma.vulnerability.count({ where }),
    ]);

    res.json({
      data: vulns.map(mapVulnRow),
      total,
      page: q.page,
      pageSize: q.pageSize,
      totalPages: Math.ceil(total / q.pageSize),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/dropped', async (req, res) => {
  try {
    const body = z.object({ ids: z.array(z.string()).optional() }).parse(req.body ?? {});
    const where: { dropped: true; id?: { in: string[] } } = { dropped: true };
    if (body.ids?.length) where.id = { in: body.ids };

    const vulns = await prisma.vulnerability.findMany({
      where,
      select: { id: true, reportPath: true, exploitPath: true, payloadPath: true },
    });
    for (const vuln of vulns) deleteFindingArtifacts(vuln);
    const { count } = await prisma.vulnerability.deleteMany({ where });
    res.json({ ok: true, deleted: count });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const nextUnexploitedQuerySchema = z.object({
  cwe:            z.string().optional(),
  repoUrl:        z.string().optional(),
  org:            z.string().optional(),
  minSeverity:    z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
  includeFailed:  z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

router.get('/next-unexploited', async (req, res) => {
  try {
    const q = nextUnexploitedQuerySchema.parse(req.query);
    const result = await getNextUnexploitedFinding({
      cwe: q.cwe,
      repoUrl: q.repoUrl,
      org: q.org,
      minSeverity: q.minSeverity,
      includeFailed: q.includeFailed,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/dropped/:id/promote', async (req, res) => {
  try {
    const vuln = await prisma.vulnerability.findUnique({ where: { id: req.params.id } });
    if (!vuln)         return res.status(404).json({ error: 'Not found' });
    if (!vuln.dropped) return res.status(400).json({ error: 'Vulnerability is not dropped' });

    const updated = await prisma.vulnerability.update({
      where: { id: req.params.id },
      data: { dropped: false },
    });

    emitActivityEvent({
      id: updated.id,
      timestamp: new Date().toISOString(),
      type: 'info',
      message: `Dropped finding ${updated.checkId} promoted to confirmed`,
    });

    res.json({ id: updated.id, dropped: updated.dropped });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const artifactsBodySchema = z.object({
  reportMd:  z.string().optional(),
  payloadPy: z.string().optional(),
  exploitPy: z.string().optional(),
});

router.post(
  '/:id/artifacts/upload',
  artifactUpload.fields([
    { name: 'report_md', maxCount: 1 },
    { name: 'payload_py', maxCount: 1 },
    { name: 'exploit_py', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const files = req.files as
        | Record<string, { buffer: Buffer }[]>
        | undefined;
      const buffers: Parameters<typeof saveFindingArtifactBuffers>[1] = {};
      if (files?.report_md?.[0]) buffers.reportMd = files.report_md[0].buffer;
      if (files?.payload_py?.[0]) buffers.payloadPy = files.payload_py[0].buffer;
      if (files?.exploit_py?.[0]) buffers.exploitPy = files.exploit_py[0].buffer;

      const saved = await saveFindingArtifactBuffers(req.params.id, buffers);
      if (!saved) return res.status(404).json({ error: 'Not found' });
      res.json(saved);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  },
);

router.post('/:id/artifacts', async (req, res) => {
  try {
    const body = artifactsBodySchema.parse(req.body);
    const saved = await saveFindingArtifacts(req.params.id, body);
    if (!saved) return res.status(404).json({ error: 'Not found' });
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

const exploitStatusSchema = z.object({
  exploitable: z.boolean(),
  note:        z.string().optional(),
});

router.patch('/:id/exploit-status', async (req, res) => {
  try {
    const body = exploitStatusSchema.parse(req.body);
    const updated = await setFindingExploitable(req.params.id, body.exploitable, body.note);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const v = await prisma.vulnerability.findUnique({
      where: { id: req.params.id },
      include: { scanJob: { include: { repo: true } } },
    });
    if (!v) return res.status(404).json({ error: 'Not found' });
    res.json({ ...v, repoUrl: v.scanJob.repo.url, createdAt: v.createdAt.toISOString() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Mutations ────────────────────────────────────────────────────

router.patch('/:id/false-positive', async (req, res) => {
  try {
    const { value } = z.object({ value: z.boolean() }).parse(req.body);
    const updated = await prisma.vulnerability.update({
      where: { id: req.params.id },
      data: { isFalsePositive: value },
    });
    res.json({ id: updated.id, isFalsePositive: updated.isFalsePositive });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.patch('/:id/cve-reported', async (req, res) => {
  try {
    const { value } = z.object({ value: z.boolean() }).parse(req.body);
    const updated = await prisma.vulnerability.update({
      where: { id: req.params.id },
      data: {
        cveReported: value,
        cveReportedAt: value ? new Date() : null,
      },
    });
    res.json({
      id: updated.id,
      cveReported: updated.cveReported,
      cveReportedAt: updated.cveReportedAt?.toISOString() ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Promote a dropped finding to confirmed (clears the dropped flag)
router.patch('/:id/promote', async (req, res) => {
  try {
    const vuln = await prisma.vulnerability.findUnique({ where: { id: req.params.id } });
    if (!vuln)            return res.status(404).json({ error: 'Not found' });
    if (!vuln.dropped)    return res.status(400).json({ error: 'Vulnerability is not dropped' });

    const updated = await prisma.vulnerability.update({
      where: { id: req.params.id },
      data: { dropped: false },
    });

    emitActivityEvent({
      id: updated.id,
      timestamp: new Date().toISOString(),
      type: 'info',
      message: `Dropped finding ${updated.checkId} promoted to confirmed`,
    });

    res.json({ id: updated.id, dropped: updated.dropped });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Single exploit trigger ────────────────────────────────────────

router.post('/:id/generate-exploit', async (req, res) => {
  try {
    const vuln = await prisma.vulnerability.findUnique({
      where: { id: req.params.id },
      include: { scanJob: { include: { repo: true } } },
    });
    if (!vuln) return res.status(404).json({ error: 'Not found' });

    // Block if already running or finished
    if (vuln.exploitStatus !== null) {
      return res.status(409).json({ error: `Exploit already ${vuln.exploitStatus} — delete it first to re-run` });
    }

    await prisma.vulnerability.update({
      where: { id: vuln.id },
      data: { exploitStatus: 'pending', exploitError: null },
    });

    const repo = vuln.scanJob.repo;
    await exploitQueue.add('exploit', {
      vulnId:        vuln.id,
      scanJobId:     vuln.scanJobId,
      vulnJson:      vuln.metadataJson as never,
      sourceAcquisition: {
        packageType: (repo.packageType as PackageType) ?? 'git',
        target:      repo.packageName ?? repo.url,
        version:     repo.packageVersion ?? undefined,
      },
    });

    res.json({ vulnId: vuln.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Bulk exploit trigger ──────────────────────────────────────────
// POST /api/vulnerabilities/bulk-exploit
// Body: { vulnIds?, severity?, includeDropped?, scanJobId?, onlyNew? }
//   vulnIds       — explicit list; if omitted use filters below
//   severity      — ['CRITICAL','HIGH'] filter (ignored when vulnIds given)
//   includeDropped— include dropped=true vulns (default false)
//   scanJobId     — scope to a single scan job (optional)
//   onlyNew       — skip vulns where exploitStatus is already set (default true)

const bulkExploitSchema = z.object({
  vulnIds:        z.array(z.string()).optional(),
  severity:       z.array(z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])).optional(),
  includeDropped: z.boolean().default(false),
  scanJobId:      z.string().optional(),
  onlyNew:        z.boolean().default(true),
});

router.post('/bulk-exploit', async (req, res) => {
  try {
    const body = bulkExploitSchema.parse(req.body);

    const repoSelect = {
      url:            true,
      packageType:    true,
      packageName:    true,
      packageVersion: true,
    } as const;
    const vulnSelect = {
      id:          true,
      scanJobId:   true,
      metadataJson: true,
      scanJob:     { select: { repo: { select: repoSelect } } },
    } as const;

    type BulkVuln = Awaited<ReturnType<typeof prisma.vulnerability.findMany<{ select: typeof vulnSelect }>>>[number];

    let vulns: BulkVuln[];

    if (body.vulnIds?.length) {
      vulns = await prisma.vulnerability.findMany({
        where: {
          id:              { in: body.vulnIds },
          isFalsePositive: false,
          ...(body.onlyNew ? { exploitStatus: null } : {}),
        },
        select: vulnSelect,
      });
    } else {
      const where: Record<string, unknown> = {
        isFalsePositive: false,
        ...(body.onlyNew          ? { exploitStatus: null }      : {}),
        ...(body.severity?.length ? { severity: { in: body.severity } } : {}),
        ...(!body.includeDropped  ? { dropped: false }           : {}),
        ...(body.scanJobId        ? { scanJobId: body.scanJobId } : {}),
      };
      vulns = await prisma.vulnerability.findMany({ where, select: vulnSelect });
    }

    if (!vulns.length) return res.json({ queued: 0 });

    await prisma.vulnerability.updateMany({
      where: { id: { in: vulns.map((v) => v.id) } },
      data:  { exploitStatus: 'pending', exploitError: null },
    });

    for (const v of vulns) {
      const repo = v.scanJob.repo;
      await exploitQueue.add('exploit', {
        vulnId:        v.id,
        scanJobId:     v.scanJobId,
        vulnJson:      v.metadataJson as never,
        sourceAcquisition: {
          packageType: (repo.packageType as PackageType) ?? 'git',
          target:      repo.packageName ?? repo.url,
          version:     repo.packageVersion ?? undefined,
        },
      });
    }

    res.json({ queued: vulns.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const vuln = await prisma.vulnerability.findUnique({ where: { id: req.params.id } });
    if (!vuln) return res.status(404).json({ error: 'Not found' });

    deleteFindingArtifacts(vuln);
    await prisma.vulnerability.delete({ where: { id: vuln.id } });

    res.json({ ok: true, id: vuln.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Delete ────────────────────────────────────────────────────────

router.delete('/', async (req, res) => {
  try {
    const { dropped } = z.object({ dropped: z.enum(['yes', 'no', 'all']).default('all') }).parse(req.query);
    const where =
      dropped === 'yes' ? { dropped: true }  :
      dropped === 'no'  ? { dropped: false } :
      {};
    const { count } = await prisma.vulnerability.deleteMany({ where });
    res.json({ ok: true, deleted: count });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
