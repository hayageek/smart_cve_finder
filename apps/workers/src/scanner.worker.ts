import { Worker, type Job } from 'bullmq';
import { acquireSource, injectSkills, runCveScan } from './pipeline.js';
import { rm } from 'fs/promises';
import path from 'path';
import { v7 as uuidv7 } from 'uuid';
import { PrismaClient } from '@prisma/client';
import {
  QUEUE_NAMES,
  CWE_CVSS_MAP,
  SEVERITY_ORDER,
  type ScanJobData,
  type CveJobData,
  type ExploitJobData,
  type VulnerabilityFinding,
  type DroppedFinding,
} from '@secscan/shared';
import { config, redisOptions } from './config.js';
import { createWorkerLogger } from './logger.js';
import { notifyOnCritical, notifyOnScanComplete } from './notify.js';
import { requireScanJob, updateScanJob } from './db-helpers.js';
import { Queue } from 'bullmq';

const prisma = new PrismaClient();
const log = createWorkerLogger('scanner');

const cveQueue = new Queue<CveJobData>(QUEUE_NAMES.CVE_SCAN, { connection: redisOptions });
const exploitQueue = new Queue<ExploitJobData>(QUEUE_NAMES.EXPLOIT_GEN, { connection: redisOptions });

/** Common vulnerability columns shared by confirmed and dropped findings. */
function vulnRowFromScan(fields: {
  checkId: string;
  path: string;
  lineStart: number;
  lineEnd: number | null;
  severity: string;
  cwe: string;
  vulnType: string | null;
  message: string | null;
  metadataJson: object;
}) {
  return {
    checkId: fields.checkId,
    path: fields.path,
    lineStart: fields.lineStart,
    lineEnd: fields.lineEnd,
    severity: fields.severity,
    cwe: fields.cwe,
    vulnType: fields.vulnType,
    message: fields.message,
    metadataJson: fields.metadataJson,
    cvssScore: CWE_CVSS_MAP[fields.cwe] ?? null,
  };
}

function metadataFromDropped(d: DroppedFinding): object {
  if (d.metadata) return d.metadata as object;
  return {
    cwe: d.cwe ?? 'UNKNOWN',
    ...(d.vulnerability_type ? { vulnerability_type: d.vulnerability_type } : {}),
  };
}

// ── Clone worker ──────────────────────────────────────────────────

export const scanWorker = new Worker<ScanJobData>(
  QUEUE_NAMES.REPO_SCAN,
  async (job: Job<ScanJobData>) => {
    const { repoUrl, packageType, packageName, packageVersion, scanJobId, forceRescan } = job.data;
    const jobLog = log.child({ jobId: job.id, scanJobId, repoUrl, packageType });

    if (!(await requireScanJob(prisma, scanJobId, jobLog))) {
      return { skipped: true, reason: 'scan-job-not-found' };
    }

    await updateScanJob(prisma, scanJobId, {
      bullJobId: job.id ?? null,
      status: 'cloning',
      stage: 'clone',
      startedAt: new Date(),
    });
    await prisma.repo.update({ where: { url: repoUrl }, data: { status: 'cloning' } });

    // Dedup check
    if (!forceRescan) {
      const cfg = await prisma.workerConfig.findFirst();
      const dedupHours = cfg?.dedupWindowHours ?? config.SCAN_DEDUP_WINDOW_HOURS;
      if (dedupHours > 0) {
        const repo = await prisma.repo.findUnique({ where: { url: repoUrl } });
        if (repo?.lastScannedAt) {
          const elapsed = (Date.now() - repo.lastScannedAt.getTime()) / 3600000;
          if (elapsed < dedupHours) {
            jobLog.info('Dedup: scanned recently, skipping');
            await updateScanJob(prisma, scanJobId, { status: 'skipped', finishedAt: new Date() });
            await prisma.repo.update({ where: { url: repoUrl }, data: { status: 'skipped' } });
            return { skipped: true };
          }
        }
      }
    }

    const workspacePath = path.join(config.WORKSPACES_DIR, job.id ?? scanJobId);
    const { mkdir } = await import('fs/promises');
    await mkdir(workspacePath, { recursive: true });
    await job.updateProgress(5);

    // ── Acquire source code (via pipeline) ───────────────────────
    const pipelineLog = {
      info:  (msg: string) => jobLog.info(msg),
      warn:  (msg: string) => jobLog.warn(msg),
      error: (msg: string) => jobLog.error(msg),
    };

    let acquireResult: Awaited<ReturnType<typeof acquireSource>>;
    try {
      acquireResult = await acquireSource(
        {
          packageType: (packageType as 'git' | 'npm' | 'pip') ?? 'git',
          target: packageName ?? repoUrl,
          version: packageVersion ?? undefined,
          destDir: workspacePath,
          gitDepth: config.GIT_CLONE_DEPTH,
        },
        pipelineLog,
      );
    } catch (err: unknown) {
      const msg = String(err);
      jobLog.warn({ err: msg }, 'Source acquisition failed');
      await prisma.repo.update({ where: { url: repoUrl }, data: { status: 'failed' } });
      await updateScanJob(prisma, scanJobId, { status: 'failed', error: msg, finishedAt: new Date() });
      await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
      return { skipped: true, reason: msg };
    }

    if (acquireResult.isPrivate) {
      await prisma.repo.update({ where: { url: repoUrl }, data: { isPrivate: true, status: 'failed' } });
      await updateScanJob(prisma, scanJobId, { status: 'failed', error: 'Repository is private or inaccessible', finishedAt: new Date() });
      await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
      return { skipped: true, reason: 'private' };
    }

    // Persist resolved version / repo URL for packages
    if (acquireResult.resolvedVersion || acquireResult.repoUrl !== undefined) {
      await prisma.repo.update({
        where: { url: repoUrl },
        data: {
          repoUrl: acquireResult.repoUrl,
          packageVersion: acquireResult.resolvedVersion,
          isPrivate: false,
        },
      });
    } else {
      await prisma.repo.update({ where: { url: repoUrl }, data: { isPrivate: false } });
    }

    await job.updateProgress(30);

    await updateScanJob(prisma, scanJobId, { status: 'scanning', stage: 'cve-scan' });
    await prisma.repo.update({ where: { url: repoUrl }, data: { status: 'scanning' } });
    await cveQueue.add('cve-scan', {
      repoUrl,
      scanJobId,
      workspacePath,
      sourceAcquisition: {
        packageType: (packageType as 'git' | 'npm' | 'pip') ?? 'git',
        target: packageName ?? repoUrl,
        version: packageVersion ?? undefined,
      },
    });

    return { workspacePath };
  },
  {
    connection: redisOptions,
    concurrency: config.SCANNER_CONCURRENCY,
    settings: { backoffStrategy: () => config.SCANNER_BACKOFF_DELAY_MS },
  },
);

// ── CVE scan worker ───────────────────────────────────────────────

export const cveWorker = new Worker<CveJobData>(
  QUEUE_NAMES.CVE_SCAN,
  async (job: Job<CveJobData>) => {
    const { repoUrl, scanJobId, workspacePath, sourceAcquisition } = job.data;
    const jobLog = log.child({ jobId: job.id, scanJobId, repoUrl });

    if (!(await requireScanJob(prisma, scanJobId, jobLog))) {
      await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
      return { skipped: true, reason: 'scan-job-not-found' };
    }

    jobLog.info('Injecting security skills');
    await job.updateProgress(35);

    await injectSkills(
      {
        workspacePath,
        skillsDir:    config.SKILLS_DIR,
        skillsRepoUrl: config.SKILLS_REPO_URL,
        tmpDir:       config.WORKSPACES_DIR,
      },
      {
        info:  (msg) => jobLog.info(msg),
        warn:  (msg) => jobLog.warn(msg),
        error: (msg) => jobLog.error(msg),
      },
    );

    await job.updateProgress(50);

    jobLog.info({ skill: '/cve-pattern-hunter', cwd: workspacePath, model: config.CURSOR_AGENT_MODEL }, 'Running CVE scan via @cursor/sdk');

    let findings: VulnerabilityFinding[];
    let drops: DroppedFinding[];
    let rawCveOutput: string;
    try {
      ({ findings, drops, rawOutput: rawCveOutput } = await runCveScan(
        {
          cwd:   workspacePath,
          model: config.CURSOR_AGENT_MODEL,
          apiKey: config.CURSOR_API_KEY,
          debug: config.DEBUG_CURSOR,
        },
        {
          info:  (msg) => jobLog.info(msg),
          warn:  (msg) => jobLog.warn(msg),
          error: (msg) => jobLog.error(msg),
        },
      ));
    } catch (err: unknown) {
      const execErr = err as { message?: string };
      throw new Error(`cve-pattern-hunter failed: ${execErr.message}`);
    }

    if (config.DEBUG_CURSOR) {
      jobLog.debug(`\n${'─'.repeat(60)}\nCURSOR SDK OUTPUT (${rawCveOutput.length} chars):\n${rawCveOutput}\n${'─'.repeat(60)}`);
    } else {
      jobLog.info({ outputChars: rawCveOutput.length, findings: findings.length, drops: drops.length }, 'CVE scan finished');
    }
    await job.updateProgress(75);

    const workerCfg = await prisma.workerConfig.findFirst();
    const minSeverity = workerCfg?.exploitMinSeverity ?? config.EXPLOIT_MIN_SEVERITY;
    const includeDropped = workerCfg?.exploitIncludeDropped ?? config.EXPLOIT_INCLUDE_DROPPED;

    // Persist confirmed findings — we generate the UUID so it flows unchanged
    // into the exploit queue, artifact directory, and any future MCP lookup.
    const vulns = await Promise.all(
      findings.map((f) =>
        prisma.vulnerability.create({
          data: {
            id: uuidv7(),
            scanJobId,
            ...vulnRowFromScan({
              checkId: f.check_id,
              path: f.path,
              lineStart: f.start.line,
              lineEnd: f.end.line,
              severity: f.extra.severity,
              cwe: f.extra.metadata.cwe,
              vulnType: f.extra.metadata.vulnerability_type,
              message: f.extra.message,
              metadataJson: f.extra.metadata as object,
            }),
          },
        }),
      ),
    );

    // Persist dropped findings in the same table with dropped=true (+ dropReason, dropEvidence)
    const droppedVulns = await Promise.all(
      drops.map((d) => {
        const cwe = d.cwe ?? 'UNKNOWN';
        return prisma.vulnerability.create({
          data: {
            id: uuidv7(),
            scanJobId,
            ...vulnRowFromScan({
              checkId: d.check_id,
              path: d.path,
              lineStart: d.line ?? 0,
              lineEnd: d.line_end ?? null,
              severity: d.severity ?? 'LOW',
              cwe,
              vulnType: d.vulnerability_type ?? null,
              message: d.message ?? null,
              metadataJson: metadataFromDropped(d),
            }),
            dropped: true,
            dropReason: d.drop_reason,
            dropEvidence: d.drop_evidence,
          },
        });
      }),
    );

    // Queue confirmed vulns that meet severity threshold
    const exploitVulns = vulns.filter(
      (v) => SEVERITY_ORDER[v.severity] >= SEVERITY_ORDER[minSeverity],
    );

    for (const vuln of exploitVulns) {
      const finding = findings.find((f) => f.check_id === vuln.checkId);
      if (!finding) continue;
      await prisma.vulnerability.update({ where: { id: vuln.id }, data: { exploitStatus: 'pending' } });
      await exploitQueue.add('exploit', { vulnId: vuln.id, scanJobId, vulnJson: finding, workspacePath, sourceAcquisition });
    }

    // Optionally also queue dropped vulns if config says so
    if (includeDropped) {
      for (const vuln of droppedVulns) {
        await prisma.vulnerability.update({ where: { id: vuln.id }, data: { exploitStatus: 'pending' } });
        await exploitQueue.add('exploit', {
          vulnId: vuln.id,
          scanJobId,
          vulnJson: {} as VulnerabilityFinding,
          workspacePath,
          sourceAcquisition,
        });
      }
    }

    await updateScanJob(prisma, scanJobId, { status: 'exploiting', stage: 'exploit-gen' });
    await prisma.repo.update({ where: { url: repoUrl }, data: { status: 'exploiting', lastScannedAt: new Date() } });
    await job.updateProgress(90);

    const criticals = vulns.filter((v) => v.severity === 'CRITICAL').length;
    if (criticals > 0) await notifyOnCritical(repoUrl, criticals);
    await notifyOnScanComplete(repoUrl, vulns.length, scanJobId);

    const totalExploitsQueued = exploitVulns.length + (includeDropped ? droppedVulns.length : 0);
    if (totalExploitsQueued === 0) {
      scheduleWorkspaceCleanup(workspacePath, workerCfg?.workspaceCleanupHours ?? config.WORKSPACE_CLEANUP_AFTER_HOURS);
      await updateScanJob(prisma, scanJobId, { status: 'done', finishedAt: new Date() });
      await prisma.repo.update({ where: { url: repoUrl }, data: { status: 'done' } });
    }

    return { vulnsFound: vulns.length, dropsFound: drops.length, exploitsQueued: totalExploitsQueued };
  },
  { connection: redisOptions, concurrency: config.SCANNER_CONCURRENCY },
);


function scheduleWorkspaceCleanup(workspacePath: string, afterHours: number) {
  if (afterHours <= 0) return;
  setTimeout(async () => {
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
    log.info({ workspacePath }, 'Workspace cleaned up');
  }, afterHours * 3600 * 1000);
}

scanWorker.on('failed', async (job, err) => {
  if (!job) return;
  log.error({ jobId: job.id, err: err.message }, 'Scan job failed');
  const { scanJobId, repoUrl } = job.data;
  await updateScanJob(prisma, scanJobId, { status: 'failed', error: err.message, finishedAt: new Date() });
  await prisma.repo.update({ where: { url: repoUrl }, data: { status: 'failed' } }).catch(() => {});
});

cveWorker.on('failed', async (job, err) => {
  if (!job) return;
  log.error({ jobId: job.id, err: err.message }, 'CVE scan job failed');
  const { scanJobId, repoUrl } = job.data;
  await updateScanJob(prisma, scanJobId, { status: 'failed', error: err.message, finishedAt: new Date() });
  await prisma.repo.update({ where: { url: repoUrl }, data: { status: 'failed' } }).catch(() => {});
});
