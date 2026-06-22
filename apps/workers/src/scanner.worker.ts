import { Worker, type Job } from 'bullmq';
import { Queue } from 'bullmq';
import { acquireSource, injectSkills, runCveScan, runSecretScan } from './pipeline.js';
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
  type SecretFinding,
  type DroppedSecretFinding,
  type ScanMode,
  type WorkerConfig,
  type PackageType,
} from '@secscan/shared';
import { config, redisOptions } from './config.js';
import { createWorkerLogger } from './logger.js';
import { notifyOnCritical, notifyOnScanComplete } from './notify.js';
import { requireScanJob, updateScanJob } from './db-helpers.js';
import { applyGitHubScanGates } from './github-gates.js';
import {
  evaluateRevisionGate,
  resolvePipelinesToRun,
  storedRevisionsFromRepo,
} from '@secscan/source-revision';
import { simpleGit } from 'simple-git';
import { isInvalidSecretShape } from '@secscan/secret-scan';

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
    severityRank: SEVERITY_ORDER[fields.severity] ?? 0,
    cwe: fields.cwe,
    vulnType: fields.vulnType,
    message: fields.message,
    metadataJson: fields.metadataJson,
    cvssScore: CWE_CVSS_MAP[fields.cwe] ?? null,
  };
}

function metadataFromDropped(d: DroppedFinding): object {
  const meta = d.extra?.metadata ?? d.metadata;
  if (meta) return meta as object;
  const vulnType = d.extra?.metadata?.vulnerability_type ?? d.vulnerability_type;
  return {
    cwe: d.extra?.metadata?.cwe ?? d.cwe ?? 'UNKNOWN',
    ...(vulnType ? { vulnerability_type: vulnType } : {}),
  };
}

/** Common secret columns shared by confirmed and dropped findings. */
function secretRowFromScan(fields: {
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
  metadataJson: object;
}) {
  return {
    ruleId: fields.ruleId,
    path: fields.path,
    lineStart: fields.lineStart,
    lineEnd: fields.lineEnd,
    severity: fields.severity,
    severityRank: SEVERITY_ORDER[fields.severity] ?? 0,
    secretType: fields.secretType,
    redactedValue: fields.redactedValue,
    verifyStatus: fields.verifyStatus,
    detectorName: fields.detectorName,
    message: fields.message,
    metadataJson: fields.metadataJson,
  };
}

function metadataFromDroppedSecret(d: DroppedSecretFinding): object {
  const meta = d.extra?.metadata;
  if (meta) return meta as object;
  return {
    secret_type: d.extra?.metadata?.secret_type ?? d.rule_id,
    verify_status: d.extra?.metadata?.verify_status ?? 'unverified',
  };
}

/** Skip polluted gitleaks captures (`;`, `\`, leading `.`, path `/` fragments, etc.). */
function isPersistableSecret(redactedValue: string | null | undefined): boolean {
  if (!redactedValue?.trim()) return false;
  return !isInvalidSecretShape(redactedValue);
}

function resolveScanMode(mode?: ScanMode): ScanMode {
  if (mode === 'cve' || mode === 'secrets' || mode === 'both') return mode;
  return 'both';
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
    const { repoUrl, packageType, packageName, packageVersion, scanJobId, forceRescan, scanMode: jobScanMode } = job.data;
    const scanMode = resolveScanMode(jobScanMode);
    let runCve = scanMode === 'both' || scanMode === 'cve';
    let runSecrets = scanMode === 'both' || scanMode === 'secrets';
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
        scanMode,
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

    if (!forceRescan) {
      const repoRecord = await prisma.repo.findUnique({ where: { url: repoUrl } });
      if (repoRecord) {
        const gate = await evaluateRevisionGate(
          {
            status: repoRecord.status,
            packageType: repoRecord.packageType,
            url: repoRecord.url,
            packageName: repoRecord.packageName,
            packageVersion: repoRecord.packageVersion,
            lastScannedRevision: repoRecord.lastScannedRevision,
            lastCveScannedRevision: repoRecord.lastCveScannedRevision,
            lastSecretScannedRevision: repoRecord.lastSecretScannedRevision,
          },
          { force: false, scanMode, githubToken: config.GITHUB_TOKEN },
        );
        jobLog.info({ gate: gate.log, repoUrl, scanMode }, 'scanner.worker: revision-gate');
        if (gate.action === 'skip') {
          jobLog.info(
            {
              repoUrl,
              packageType,
              scanMode,
              lastCveScannedRevision: repoRecord.lastCveScannedRevision,
              lastSecretScannedRevision: repoRecord.lastSecretScannedRevision,
              remoteRevision: gate.remote.revision,
              remoteKind: gate.remote.kind,
            },
            'scanner.worker: skipping — all requested pipelines already scanned at this revision (no clone)',
          );
          await updateScanJob(prisma, scanJobId, {
            status: 'skipped',
            error: gate.message,
            finishedAt: new Date(),
          });
          await prisma.repo.update({
            where: { url: repoUrl },
            data: { status: repoRecord.status === 'failed' ? 'failed' : 'done' },
          });
          return { skipped: true, reason: 'unchanged-revision', remoteRevision: gate.remote.revision };
        }
        runCve = gate.pipelines.runCve;
        runSecrets = gate.pipelines.runSecrets;
        if (gate.lookupFailed) {
          jobLog.warn(
            { repoUrl, lookupError: gate.lookupError },
            'scanner.worker: revision lookup failed; proceeding with scan (fail-open)',
          );
        } else if (gate.remote) {
          jobLog.info(
            {
              repoUrl,
              remoteRevision: gate.remote.revision,
              remoteKind: gate.remote.kind,
              runCve,
              runSecrets,
            },
            'scanner.worker: upstream revision resolved — proceeding with pending pipelines',
          );
        }
      }
    } else {
      jobLog.info({ repoUrl, scanMode }, 'scanner.worker: forceRescan=true — bypassing revision-gate');
    }

    const gate = await applyGitHubScanGates(prisma, repoUrl, jobLog);
    if (gate.skip) {
      await updateScanJob(prisma, scanJobId, {
        status: 'skipped',
        error: gate.message,
        finishedAt: new Date(),
      });
      await prisma.repo.update({
        where: { url: repoUrl },
        data: { status: 'skipped', lastScannedAt: new Date() },
      });
      return { skipped: true, reason: gate.reason };
    }

    const workspacePath = path.join(config.WORKSPACES_DIR, scanJobId);
    let scannedRevision: string | undefined;

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

      if (packageType === 'git') {
        try {
          scannedRevision = (await simpleGit(workspacePath).revparse(['HEAD'])).trim();
          jobLog.info({ repoUrl, scannedRevision }, 'scanner.worker: resolved git HEAD after clone');
        } catch (err) {
          jobLog.warn({ repoUrl, err: String(err) }, 'scanner.worker: could not resolve git HEAD revision');
        }
      } else if (acquireResult.resolvedVersion) {
        scannedRevision = acquireResult.resolvedVersion;
        jobLog.info(
          { repoUrl, packageType, scannedRevision },
          'scanner.worker: resolved package version after download',
        );
      }

      if (!forceRescan && scannedRevision) {
        const repoRecord = await prisma.repo.findUnique({ where: { url: repoUrl } });
        if (repoRecord) {
          const stored = storedRevisionsFromRepo(repoRecord);
          const plan = resolvePipelinesToRun(scanMode, stored, scannedRevision, false);
          if (plan.runCve !== runCve || plan.runSecrets !== runSecrets) {
            jobLog.info(
              {
                repoUrl,
                scanMode,
                scannedRevision,
                runCve: plan.runCve,
                runSecrets: plan.runSecrets,
              },
              'scanner.worker: adjusted pipelines after clone based on per-pipeline revisions',
            );
          }
          runCve = plan.runCve;
          runSecrets = plan.runSecrets;
        }
      }

      if (!runCve && !runSecrets) {
        jobLog.info(
          { repoUrl, scanMode, scannedRevision },
          'scanner.worker: all requested pipelines already scanned at this revision — skipping after clone',
        );
        await updateScanJob(prisma, scanJobId, {
          status: 'skipped',
          error: 'All requested pipelines already scanned at this revision',
          finishedAt: new Date(),
        });
        await prisma.repo.update({
          where: { url: repoUrl },
          data: { status: 'done', lastScannedAt: new Date() },
        });
        return { skipped: true, reason: 'unchanged-revision', remoteRevision: scannedRevision };
      }

      await job.updateProgress(20);
      await updateScanJob(prisma, scanJobId, { status: 'scanning', stage: 'scan' });
      await prisma.repo.update({ where: { url: repoUrl }, data: { status: 'scanning' } });

      jobLog.info({ workspacePath, skillsDir: config.SKILLS_DIR, cveScanMode: config.CVE_SCAN_MODE }, 'scanner.worker: injecting security skills');
      await injectSkills(
        {
          workspacePath,
          skillsDir:     config.SKILLS_DIR,
          skillsRepoUrl: config.SKILLS_REPO_URL,
          tmpDir:        config.WORKSPACES_DIR,
          cveScanMode:   config.CVE_SCAN_MODE,
        },
        pipelineLog,
      );

      await job.updateProgress(35);

      let findings: VulnerabilityFinding[] = [];
      let drops: DroppedFinding[] = [];
      let rawCveOutput = '';
      let secretFindings: SecretFinding[] = [];
      let secretDrops: DroppedSecretFinding[] = [];
      let rawSecretOutput = '';

      const cveScanPromise = runCve
        ? (async () => {
            jobLog.info(
              {
                skill: config.CVE_SCAN_MODE === 'semgrep-pattern-hunter' ? '/cve-pattern-hunter' : '/cve-ai-finder',
                cveScanMode: config.CVE_SCAN_MODE,
                cwd: workspacePath,
                model: config.CURSOR_AGENT_MODEL,
              },
              'scanner.worker: starting CVE scan',
            );
            try {
              return await runCveScan(
                {
                  cwd: workspacePath,
                  model: config.CURSOR_AGENT_MODEL,
                  apiKey: config.CURSOR_API_KEY,
                  debug: config.DEBUG_CURSOR,
                  scanMode: config.CVE_SCAN_MODE,
                  semgrepEnabled: config.CVE_SEMGREP_ENABLED,
                  semgrepBin: config.CVE_SEMGREP_BIN,
                  semgrepJobs: config.CVE_SEMGREP_JOBS,
                },
                pipelineLog,
              );
            } catch (err: unknown) {
              const execErr = err as { message?: string };
              throw new Error(`CVE scan failed (${config.CVE_SCAN_MODE}): ${execErr.message}`);
            }
          })()
        : Promise.resolve({ findings: [], drops: [], rawOutput: '' });

      const secretScanPromise = runSecrets
        ? (async () => {
            jobLog.info(
              { skill: '/secret-finding-triage', cwd: workspacePath },
              'scanner.worker: starting secret scan',
            );
            try {
              return await runSecretScan(
                {
                  cwd: workspacePath,
                  model: config.CURSOR_AGENT_MODEL,
                  apiKey: config.CURSOR_API_KEY,
                  debug: config.DEBUG_CURSOR,
                  gitleaksBin: config.SECRET_GITLEAKS_BIN,
                  trufflehogBin: config.SECRET_TRUFFLEHOG_BIN,
                  minSeverity: config.SECRET_MIN_SEVERITY,
                  gateOnly: config.SECRET_GATE_ONLY,
                  redactSecrets: config.SECRET_REDACT,
                  maxGitleaksRawHits: config.SECRET_MAX_GITLEAKS_RAW_HITS,
                  noGit: packageType !== 'git',
                },
                pipelineLog,
              );
            } catch (err: unknown) {
              const execErr = err as { message?: string };
              throw new Error(`secret scan failed: ${execErr.message}`);
            }
          })()
        : Promise.resolve({ findings: [], drops: [], rawOutput: '' });

      const [cveResult, secretResult] = await Promise.all([cveScanPromise, secretScanPromise]);
      findings = cveResult.findings;
      drops = cveResult.drops;
      rawCveOutput = cveResult.rawOutput;
      secretFindings = secretResult.findings;
      secretDrops = secretResult.drops;
      rawSecretOutput = secretResult.rawOutput;

      if (config.DEBUG_CURSOR) {
        if (rawCveOutput) {
          jobLog.debug(`\n${'─'.repeat(60)}\nCVE OUTPUT (${rawCveOutput.length} chars):\n${rawCveOutput}\n${'─'.repeat(60)}`);
        }
        if (rawSecretOutput) {
          jobLog.debug(`\n${'─'.repeat(60)}\nSECRET OUTPUT (${rawSecretOutput.length} chars):\n${rawSecretOutput}\n${'─'.repeat(60)}`);
        }
      } else {
        jobLog.info(
          {
            cveFindings: findings.length,
            cveDrops: drops.length,
            secretFindings: secretFindings.length,
            secretDrops: secretDrops.length,
          },
          'Scan pipelines finished',
        );
      }
      await job.updateProgress(75);

      const validatedFindings = runCve ? findings.filter((f) => {
        const fullPath = path.join(workspacePath, f.path);
        if (!existsSync(fullPath)) {
          jobLog.warn(
            { checkId: f.check_id, reportedPath: f.path, fullPath, workspace: workspacePath },
            'Confirmed finding discarded — reported path does not exist in workspace (possible AI hallucination)',
          );
          return false;
        }
        return true;
      }) : [];

      const discarded = runCve ? findings.length - validatedFindings.length : 0;
      if (discarded > 0) {
        jobLog.warn(
          { discarded, total: findings.length, workspace: workspacePath },
          'Discarded confirmed findings with non-existent paths',
        );
      }

      if (runCve && findings.length > 0 && validatedFindings.length === 0) {
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

      const validatedSecrets = runSecrets ? secretFindings.filter((f) => {
        const fullPath = path.join(workspacePath, f.path);
        if (!existsSync(fullPath)) {
          jobLog.warn(
            { ruleId: f.rule_id, reportedPath: f.path },
            'Secret finding discarded — path does not exist in workspace',
          );
          return false;
        }
        return true;
      }) : [];
      secretFindings = validatedSecrets;

      const workerCfg = (await prisma.workerConfig.findFirst()) as WorkerConfig | null;
      const autoQueue = workerCfg?.autoQueueExploits ?? false;
      const minSeverity = workerCfg?.exploitMinSeverity ?? config.EXPLOIT_MIN_SEVERITY;
      const includeDropped = workerCfg?.exploitIncludeDropped ?? config.EXPLOIT_INCLUDE_DROPPED;

      const vulns = runCve
        ? await Promise.all(
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
          )
        : [];

      const droppedVulns = runCve
        ? await Promise.all(
            drops.map((d) => {
              const meta = d.extra?.metadata ?? d.metadata;
              const cwe = String(meta?.cwe ?? d.cwe ?? 'UNKNOWN');
              return prisma.vulnerability.create({
                data: {
                  id: uuidv7(),
                  scanJobId,
                  ...vulnRowFromScan({
                    checkId: d.check_id,
                    path: d.path,
                    lineStart: d.start?.line ?? d.line ?? 0,
                    lineEnd: d.end?.line ?? d.line_end ?? null,
                    severity: d.extra?.severity ?? d.severity ?? 'LOW',
                    cwe,
                    vulnType: String(meta?.vulnerability_type ?? d.vulnerability_type ?? '') || null,
                    message: String(d.extra?.message ?? d.message ?? '') || null,
                    metadataJson: metadataFromDropped(d),
                  }),
                  dropped: true,
                  dropReason: d.drop_reason,
                  dropEvidence: d.drop_evidence,
                },
              });
            }),
          )
        : [];

      const persistableFindings = runSecrets
        ? secretFindings.filter((f) => isPersistableSecret(f.extra.metadata.redacted_value))
        : [];
      const persistableDrops = runSecrets
        ? secretDrops.filter((d) => isPersistableSecret(String(d.extra?.metadata?.redacted_value ?? '')))
        : [];
      if (runSecrets && persistableFindings.length < secretFindings.length) {
        jobLog.info(
          `secret shape filter skipped ${secretFindings.length - persistableFindings.length} confirmed secret(s)`,
        );
      }
      if (runSecrets && persistableDrops.length < secretDrops.length) {
        jobLog.info(
          `secret shape filter skipped ${secretDrops.length - persistableDrops.length} dropped secret(s)`,
        );
      }

      const secrets = runSecrets
        ? await Promise.all(
            persistableFindings.map((f) =>
              prisma.secret.create({
                data: {
                  id: uuidv7(),
                  scanJobId,
                  ...secretRowFromScan({
                    ruleId: f.rule_id,
                    path: f.path,
                    lineStart: f.start.line,
                    lineEnd: f.end.line ?? null,
                    severity: f.extra.severity,
                    secretType: f.extra.metadata.secret_type,
                    redactedValue: f.extra.metadata.redacted_value,
                    verifyStatus: f.extra.metadata.verify_status,
                    detectorName: f.extra.metadata.detector_name ?? null,
                    message: f.extra.message,
                    metadataJson: f.extra.metadata as object,
                  }),
                },
              }),
            ),
          )
        : [];

      const droppedSecrets = runSecrets
        ? await Promise.all(
            persistableDrops.map((d) =>
              prisma.secret.create({
                data: {
                  id: uuidv7(),
                  scanJobId,
                  ...secretRowFromScan({
                    ruleId: d.rule_id,
                    path: d.path,
                    lineStart: d.start?.line ?? 0,
                    lineEnd: d.end?.line ?? null,
                    severity: d.extra?.severity ?? 'LOW',
                    secretType: String(d.extra?.metadata?.secret_type ?? d.rule_id) || null,
                    redactedValue: String(d.extra?.metadata?.redacted_value ?? '') || null,
                    verifyStatus: String(d.extra?.metadata?.verify_status ?? 'unverified'),
                    detectorName: String(d.extra?.metadata?.detector_name ?? '') || null,
                    message: String(d.extra?.message ?? '') || null,
                    metadataJson: metadataFromDroppedSecret(d),
                  }),
                  dropped: true,
                  dropReason: d.drop_reason,
                  dropEvidence: d.drop_evidence,
                },
              }),
            ),
          )
        : [];

      const exploitVulns = runCve && autoQueue
        ? vulns.filter((v) => SEVERITY_ORDER[v.severity] >= SEVERITY_ORDER[minSeverity])
        : [];

      jobLog.info(
        {
          autoQueue,
          minSeverity,
          includeDropped,
          confirmedFindings: vulns.length,
          droppedFindings: droppedVulns.length,
          secretFindings: secrets.length,
          droppedSecrets: droppedSecrets.length,
          toQueueConfirmed: exploitVulns.length,
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
      const revisionUpdate = scannedRevision
        ? {
            lastScannedRevision: scannedRevision,
            ...(runCve ? { lastCveScannedRevision: scannedRevision } : {}),
            ...(runSecrets ? { lastSecretScannedRevision: scannedRevision } : {}),
          }
        : {};

      if (totalExploitsQueued > 0) {
        await updateScanJob(prisma, scanJobId, { status: 'exploiting', stage: 'exploit-gen' });
        await prisma.repo.update({
          where: { url: repoUrl },
          data: {
            status: 'exploiting',
            lastScannedAt: new Date(),
            ...revisionUpdate,
          },
        });
      } else {
        await updateScanJob(prisma, scanJobId, { status: 'done', finishedAt: new Date() });
        await prisma.repo.update({
          where: { url: repoUrl },
          data: {
            status: 'done',
            lastScannedAt: new Date(),
            ...revisionUpdate,
          },
        });
        if (scannedRevision) {
          jobLog.info(
            {
              repoUrl,
              scannedRevision,
              packageType,
              runCve,
              runSecrets,
            },
            'scanner.worker: stored per-pipeline revisions after successful scan',
          );
        }
      }
      await job.updateProgress(90);

      const criticals = vulns.filter((v) => v.severity === 'CRITICAL').length;
      if (criticals > 0) await notifyOnCritical(repoUrl, criticals);
      await notifyOnScanComplete(repoUrl, vulns.length, scanJobId);

      return {
        vulnsFound: vulns.length,
        secretsFound: secrets.length,
        dropsFound: drops.length + secretDrops.length,
        exploitsQueued: totalExploitsQueued,
        scanMode,
      };
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
