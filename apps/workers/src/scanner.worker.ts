import { Worker, type Job } from 'bullmq';
import { Queue } from 'bullmq';
import { acquireSource, injectSkills, runCveScan } from './pipeline.js';
import { rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { v7 as uuidv7 } from 'uuid';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  QUEUE_NAMES,
  CWE_CVSS_MAP,
  SEVERITY_ORDER,
  type ScanJobData,
  type ExploitJobData,
  type SourceAcquisitionInfo,
  type VulnerabilityFinding,
  type DroppedFinding,
  type WorkerConfig,
  type PackageType,
} from '@secscan/shared';
import { config, redisOptions } from './config.js';
import { createWorkerLogger } from './logger.js';
import { notifyOnCritical, notifyOnScanComplete } from './notify.js';
import { requireScanJob, updateScanJob } from './db-helpers.js';

const prisma = new PrismaClient();
const log = createWorkerLogger('scanner');

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

function sourceAcquisitionFromJob(job: ScanJobData): SourceAcquisitionInfo {
  return {
    packageType: (job.packageType as PackageType) ?? 'git',
    target: job.packageName ?? job.repoUrl,
    version: job.packageVersion ?? undefined,
  };
}

// ── Scanner worker: download → scan → enqueue exploits → cleanup ──

export const scanWorker = new Worker<ScanJobData>(
  QUEUE_NAMES.REPO_SCAN,
  async (job: Job<ScanJobData>) => {
    const { repoUrl, packageType, packageName, packageVersion, scanJobId, forceRescan } = job.data;
    const jobLog = log.child({ jobId: job.id, scanJobId, repoUrl, packageType });
    const sourceAcquisition = sourceAcquisitionFromJob(job.data);

    jobLog.info(
      {
        queue:          QUEUE_NAMES.REPO_SCAN,
        bullJobId:      job.id,
        scanJobId,
        repoUrl,
        packageType,
        packageName:    packageName ?? null,
        packageVersion: packageVersion ?? null,
        forceRescan:    forceRescan ?? false,
        attemptsMade:   job.attemptsMade,
        processCwd:     process.cwd(),
        WORKSPACES_DIR: config.WORKSPACES_DIR,
      },
      'scanner.worker: received scan job',
    );

    if (!(await requireScanJob(prisma, scanJobId, jobLog))) {
      jobLog.warn({ scanJobId }, 'scanner.worker: scan-job-not-found in DB, dropping');
      return { skipped: true, reason: 'scan-job-not-found' };
    }

    await updateScanJob(prisma, scanJobId, {
      bullJobId: job.id ?? null,
      status: 'cloning',
      stage: 'scan',
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

    const workspacePath = path.join(config.WORKSPACES_DIR, scanJobId);

    const pipelineLog = {
      info:  (msg: string) => jobLog.info(msg),
      warn:  (msg: string) => jobLog.warn(msg),
      error: (msg: string) => jobLog.error(msg),
    };

    try {
      jobLog.info(
        {
          workspacePath,
          WORKSPACES_DIR: config.WORKSPACES_DIR,
          scanJobId,
          bullJobId:  job.id ?? null,
          processCwd: process.cwd(),
        },
        'scanner.worker: acquiring source',
      );
      await job.updateProgress(5);

      let acquireResult: Awaited<ReturnType<typeof acquireSource>>;
      try {
        acquireResult = await acquireSource(
          {
            packageType: sourceAcquisition.packageType,
            target: sourceAcquisition.target,
            version: sourceAcquisition.version,
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
        return { skipped: true, reason: msg };
      }

      if (acquireResult.isPrivate) {
        await prisma.repo.update({ where: { url: repoUrl }, data: { isPrivate: true, status: 'failed' } });
        await updateScanJob(prisma, scanJobId, {
          status: 'failed',
          error: 'Repository is private or inaccessible',
          finishedAt: new Date(),
        });
        return { skipped: true, reason: 'private' };
      }

      if (acquireResult.resolvedVersion || acquireResult.repoUrl !== undefined || acquireResult.tarballUrl !== undefined) {
        const packageData = {
          repoUrl: acquireResult.repoUrl,
          tarballUrl: acquireResult.tarballUrl,
          packageVersion: acquireResult.resolvedVersion,
          isPrivate: false,
        } as Prisma.RepoUpdateInput;
        await prisma.repo.update({ where: { url: repoUrl }, data: packageData });
      } else {
        await prisma.repo.update({ where: { url: repoUrl }, data: { isPrivate: false } });
      }

      await job.updateProgress(20);
      await updateScanJob(prisma, scanJobId, { status: 'scanning', stage: 'scan' });
      await prisma.repo.update({ where: { url: repoUrl }, data: { status: 'scanning' } });

      jobLog.info({ workspacePath, skillsDir: config.SKILLS_DIR }, 'scanner.worker: injecting security skills');
      await injectSkills(
        {
          workspacePath,
          skillsDir:     config.SKILLS_DIR,
          skillsRepoUrl: config.SKILLS_REPO_URL,
          tmpDir:        config.WORKSPACES_DIR,
        },
        pipelineLog,
      );

      await job.updateProgress(35);

      jobLog.info(
        {
          skill:         '/cve-pattern-hunter',
          cwd:           workspacePath,
          cwdIsAbsolute: path.isAbsolute(workspacePath),
          model:         config.CURSOR_AGENT_MODEL,
          processCwd:    process.cwd(),
        },
        'scanner.worker: starting CVE scan via @cursor/sdk',
      );

      let findings: VulnerabilityFinding[];
      let drops: DroppedFinding[];
      let rawCveOutput: string;
      try {
        ({ findings, drops, rawOutput: rawCveOutput } = await runCveScan(
          {
            cwd:    workspacePath,
            model:  config.CURSOR_AGENT_MODEL,
            apiKey: config.CURSOR_API_KEY,
            debug:  config.DEBUG_CURSOR,
          },
          pipelineLog,
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

      const validatedFindings = findings.filter((f) => {
        const fullPath = path.join(workspacePath, f.path);
        if (!existsSync(fullPath)) {
          jobLog.warn(
            { checkId: f.check_id, reportedPath: f.path, fullPath, workspace: workspacePath },
            'Confirmed finding discarded — reported path does not exist in workspace (possible AI hallucination)',
          );
          return false;
        }
        return true;
      });

      const discarded = findings.length - validatedFindings.length;
      if (discarded > 0) {
        jobLog.warn(
          { discarded, total: findings.length, workspace: workspacePath },
          'Discarded confirmed findings with non-existent paths',
        );
      }

      if (findings.length > 0 && validatedFindings.length === 0) {
        jobLog.error(
          {
            discarded:   findings.length,
            workspace:   workspacePath,
            processCwd:  process.cwd(),
            samplePaths: findings.slice(0, 3).map((f) => f.path),
          },
          'ALL confirmed findings discarded — paths do not exist in workspace. ' +
          'The agent likely scanned a different directory. Check WORKSPACES_DIR and Cursor SDK cwd.',
        );
      }

      findings = validatedFindings;

      const workerCfg = (await prisma.workerConfig.findFirst()) as WorkerConfig | null;
      const autoQueue = workerCfg?.autoQueueExploits ?? false;
      const minSeverity = workerCfg?.exploitMinSeverity ?? config.EXPLOIT_MIN_SEVERITY;
      const includeDropped = workerCfg?.exploitIncludeDropped ?? config.EXPLOIT_INCLUDE_DROPPED;

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

      const exploitVulns = autoQueue
        ? vulns.filter((v) => SEVERITY_ORDER[v.severity] >= SEVERITY_ORDER[minSeverity])
        : [];

      jobLog.info(
        {
          autoQueue,
          minSeverity,
          includeDropped,
          confirmedFindings: vulns.length,
          droppedFindings:   droppedVulns.length,
          toQueueConfirmed:  exploitVulns.length,
        },
        'scanner.worker: deciding exploit auto-queue',
      );

      for (const vuln of exploitVulns) {
        const finding = findings.find((f) => f.check_id === vuln.checkId);
        if (!finding) continue;
        await prisma.vulnerability.update({ where: { id: vuln.id }, data: { exploitStatus: 'pending' } });
        const exploitBullJob = await exploitQueue.add('exploit', {
          vulnId: vuln.id,
          scanJobId,
          vulnJson: finding,
          sourceAcquisition,
        });
        jobLog.info(
          {
            queue:            QUEUE_NAMES.EXPLOIT_GEN,
            exploitBullJobId: exploitBullJob.id,
            vulnId:           vuln.id,
            checkId:          vuln.checkId,
            severity:         vuln.severity,
          },
          'scanner.worker: enqueued exploit job (confirmed)',
        );
      }

      const droppedToQueue = autoQueue && includeDropped ? droppedVulns : [];
      for (const vuln of droppedToQueue) {
        await prisma.vulnerability.update({ where: { id: vuln.id }, data: { exploitStatus: 'pending' } });
        const exploitBullJob = await exploitQueue.add('exploit', {
          vulnId: vuln.id,
          scanJobId,
          vulnJson: {} as VulnerabilityFinding,
          sourceAcquisition,
        });
        jobLog.info(
          {
            queue:            QUEUE_NAMES.EXPLOIT_GEN,
            exploitBullJobId: exploitBullJob.id,
            vulnId:           vuln.id,
            checkId:          vuln.checkId,
            severity:         vuln.severity,
          },
          'scanner.worker: enqueued exploit job (dropped)',
        );
      }

      const totalExploitsQueued = exploitVulns.length + droppedToQueue.length;
      if (totalExploitsQueued > 0) {
        await updateScanJob(prisma, scanJobId, { status: 'exploiting', stage: 'exploit-gen' });
        await prisma.repo.update({ where: { url: repoUrl }, data: { status: 'exploiting', lastScannedAt: new Date() } });
      } else {
        await updateScanJob(prisma, scanJobId, { status: 'done', finishedAt: new Date() });
        await prisma.repo.update({ where: { url: repoUrl }, data: { status: 'done', lastScannedAt: new Date() } });
      }
      await job.updateProgress(90);

      const criticals = vulns.filter((v) => v.severity === 'CRITICAL').length;
      if (criticals > 0) await notifyOnCritical(repoUrl, criticals);
      await notifyOnScanComplete(repoUrl, vulns.length, scanJobId);

      return { vulnsFound: vulns.length, dropsFound: drops.length, exploitsQueued: totalExploitsQueued };
    } finally {
      if (existsSync(workspacePath)) {
        jobLog.info({ workspacePath }, 'scanner.worker: cleaning up scan workspace');
        try {
          await rm(workspacePath, { recursive: true, force: true });
        } catch (err) {
          jobLog.warn({ workspacePath, err: String(err) }, 'scanner.worker: workspace cleanup failed');
        }
      }
    }
  },
  {
    connection: redisOptions,
    concurrency: config.SCANNER_CONCURRENCY,
    settings: { backoffStrategy: () => config.SCANNER_BACKOFF_DELAY_MS },
  },
);

scanWorker.on('failed', async (job, err) => {
  if (!job) return;
  log.error({ jobId: job.id, err: err.message }, 'Scan job failed');
  const { scanJobId, repoUrl } = job.data;
  const workspacePath = path.join(config.WORKSPACES_DIR, scanJobId);
  await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
  await updateScanJob(prisma, scanJobId, { status: 'failed', error: err.message, finishedAt: new Date() });
  await prisma.repo.update({ where: { url: repoUrl }, data: { status: 'failed' } }).catch(() => {});
});
