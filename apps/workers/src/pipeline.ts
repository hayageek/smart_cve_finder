/**
 * pipeline.ts — shared logic for source acquisition, skills injection,
 * JSON extraction, and artifact collection.
 *
 * Used by both the BullMQ workers (scanner.worker.ts, exploit.worker.ts)
 * and the local CLI (cli.ts). All functions accept a plain Logger so
 * callers can inject pino, a colour console, or a no-op.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, cp, rm, writeFile, copyFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { simpleGit } from 'simple-git';
import type { VulnerabilityFinding, DroppedFinding } from '@secscan/shared';
import { runCursorSkill } from './cursor-runner.js';
import type { RunSkillOptions } from './cursor-runner.js';

export type { VulnerabilityFinding, DroppedFinding };

const execFileAsync = promisify(execFile);

// ── Logger interface ──────────────────────────────────────────────
// Simple enough for pino, console, or the CLI's colour logger.

export interface PipelineLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: PipelineLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ── Registry types ────────────────────────────────────────────────

export interface RegistryMeta {
  resolvedVersion: string;
  tarballUrl: string;
  repoUrl: string | null;
}

// ── Source helpers ────────────────────────────────────────────────

/** Strip git+, .git suffix, git:// prefix from registry-provided repo URLs. */
export function normaliseRepoUrl(raw?: string): string | null {
  if (!raw) return null;
  return (
    raw
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/\.git$/, '')
      .trim() || null
  );
}

/** Fetch npm registry metadata for a package version (default: latest). */
export async function resolveNpm(packageName: string, version?: string): Promise<RegistryMeta> {
  const tag = version ?? 'latest';
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${tag}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) throw new Error(`npm package "${packageName}" not found`);
    if (res.status === 401 || res.status === 403)
      throw new Error(`npm package "${packageName}" is private (auth required)`);
    throw new Error(`npm registry error ${res.status}`);
  }
  const meta = (await res.json()) as {
    version: string;
    dist: { tarball: string };
    repository?: { url?: string };
  };
  return {
    resolvedVersion: meta.version,
    tarballUrl: meta.dist.tarball,
    repoUrl: normaliseRepoUrl(meta.repository?.url),
  };
}

/** Fetch PyPI metadata for a package version (default: latest). */
export async function resolvePip(packageName: string, version?: string): Promise<RegistryMeta> {
  const versionSuffix = version ? `/${encodeURIComponent(version)}` : '';
  const url = `https://pypi.org/pypi/${encodeURIComponent(packageName)}${versionSuffix}/json`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) throw new Error(`pip package "${packageName}" not found`);
    if (res.status === 401 || res.status === 403)
      throw new Error(`pip package "${packageName}" is private`);
    throw new Error(`PyPI error ${res.status}`);
  }
  const meta = (await res.json()) as {
    info: { version: string; home_page?: string; project_urls?: Record<string, string> };
    urls: Array<{ packagetype: string; url: string }>;
  };
  const sdist = meta.urls.find((u) => u.packagetype === 'sdist');
  if (!sdist) throw new Error(`No source distribution found for pip package "${packageName}"`);
  const repoUrl =
    meta.info.project_urls?.['Source'] ??
    meta.info.project_urls?.['Repository'] ??
    meta.info.project_urls?.['Homepage'] ??
    meta.info.home_page ??
    null;
  return {
    resolvedVersion: meta.info.version,
    tarballUrl: sdist.url,
    repoUrl: repoUrl ?? null,
  };
}

/** Download a tarball and extract it into destDir (strips one top-level directory). */
export async function downloadAndExtract(
  tarballUrl: string,
  destDir: string,
  log: PipelineLogger = noopLogger,
): Promise<void> {
  log.info(`Downloading ${tarballUrl}`);
  const res = await fetch(tarballUrl);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${tarballUrl}`);
  const tmpTar = path.join(destDir, '..', `_dl_${Date.now()}.tgz`);
  await writeFile(tmpTar, Buffer.from(await res.arrayBuffer()));
  log.info(`Extracting to ${destDir}`);
  try {
    await execFileAsync('tar', ['-xzf', tmpTar, '-C', destDir, '--strip-components=1']);
  } finally {
    await rm(tmpTar, { force: true }).catch(() => {});
  }
}

// ── acquireSource ─────────────────────────────────────────────────

export type PackageType = 'git' | 'npm' | 'pip';

export interface AcquireOptions {
  packageType: PackageType;
  /** Git URL (git type) or package name (npm/pip). */
  target: string;
  version?: string;
  destDir: string;
  gitDepth?: number;
}

export interface AcquireResult {
  resolvedVersion?: string;
  repoUrl?: string | null;
  /** True when the source is private / inaccessible — caller should mark it so. */
  isPrivate?: boolean;
}

/**
 * Acquire source code into `destDir`:
 *  - git  → shallow clone
 *  - npm  → resolve registry + download tarball
 *  - pip  → resolve PyPI + download sdist tarball
 */
export async function acquireSource(
  opts: AcquireOptions,
  log: PipelineLogger = noopLogger,
): Promise<AcquireResult> {
  const { packageType, target, version, destDir, gitDepth = 1 } = opts;

  if (packageType === 'npm' || packageType === 'pip') {
    log.info(`Resolving ${packageType} package: ${target}${version ? `@${version}` : ''}`);
    const meta =
      packageType === 'npm'
        ? await resolveNpm(target, version)
        : await resolvePip(target, version);
    log.info(`Resolved ${target}@${meta.resolvedVersion} — ${meta.tarballUrl}`);
    if (meta.repoUrl) log.info(`Repository: ${meta.repoUrl}`);
    await downloadAndExtract(meta.tarballUrl, destDir, log);
    return { resolvedVersion: meta.resolvedVersion, repoUrl: meta.repoUrl };
  }

  // git — destination must be empty (clone fails otherwise)
  log.info(`Cloning ${target}`);
  await mkdir(destDir, { recursive: true });
  const existing = await readdir(destDir).catch(() => [] as string[]);
  if (existing.length > 0) {
    log.warn(`Clearing non-empty directory before clone: ${destDir}`);
    await rm(destDir, { recursive: true, force: true });
    await mkdir(destDir, { recursive: true });
  }
  try {
    await simpleGit().clone(target, destDir, { '--depth': String(gitDepth) });
    log.info('Clone successful');
    return { isPrivate: false };
  } catch (cloneErr: unknown) {
    const msg = String(cloneErr).toLowerCase();
    const isAuthError =
      msg.includes('authentication failed') ||
      msg.includes('could not read username') ||
      msg.includes('repository not found') ||
      msg.includes('access denied') ||
      msg.includes('403') ||
      msg.includes('401') ||
      msg.includes('permission denied');
    if (isAuthError) {
      log.warn('Clone failed: private or inaccessible repository');
      return { isPrivate: true };
    }
    throw cloneErr;
  }
}

// ── injectSkills ──────────────────────────────────────────────────

export interface InjectSkillsOptions {
  workspacePath: string;
  skillsDir: string;
  skillsRepoUrl: string;
  /** Temp directory for git clone fallback (should be inside workspaces root). */
  tmpDir: string;
}

/**
 * Copy cve-pattern-hunter and exploit-generator skills into the workspace's
 * .cursor/skills directory. Tries skillsDir first; falls back to a git clone.
 */
export async function injectSkills(
  opts: InjectSkillsOptions,
  log: PipelineLogger = noopLogger,
): Promise<void> {
  const { workspacePath, skillsDir, skillsRepoUrl, tmpDir } = opts;
  const skillsDest = path.join(workspacePath, '.cursor', 'skills');
  await mkdir(skillsDest, { recursive: true });

  const skills = ['cve-pattern-hunter', 'exploit-generator'];

  if (existsSync(skillsDir)) {
    log.info(`Copying skills from ${skillsDir}`);
    for (const skill of skills) {
      const src = path.join(skillsDir, skill);
      if (existsSync(src)) {
        await cp(src, path.join(skillsDest, skill), { recursive: true });
        log.info(`Copied skill: ${skill}`);
      } else {
        log.warn(`Skill not found in SKILLS_DIR: ${skill}`);
      }
    }
  } else {
    log.warn(`SKILLS_DIR not found (${skillsDir}), falling back to git clone: ${skillsRepoUrl}`);
    const skillsTmp = path.join(tmpDir, `_skills_${Date.now()}`);
    try {
      await simpleGit().clone(skillsRepoUrl, skillsTmp, { '--depth': '1' });
      for (const skill of skills) {
        const src = path.join(skillsTmp, skill);
        if (existsSync(src)) {
          await cp(src, path.join(skillsDest, skill), { recursive: true });
          log.info(`Injected skill: ${skill}`);
        }
      }
    } catch (err) {
      log.error(`Skills clone failed: ${err}`);
    } finally {
      await rm(skillsTmp, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ── JSON block extraction ─────────────────────────────────────────

/**
 * Extract a JSON block delimited by <<<TAG>>> … <<<END_TAG>>> from text.
 * Falls back to parsing the whole string if delimiters are absent.
 */
export function extractJsonBlock<T>(text: string, tag: string): T | null {
  const start = `<<<${tag}>>>`;
  const end   = `<<<END_${tag}>>>`;
  const si    = text.indexOf(start);
  const ei    = text.indexOf(end);
  if (si === -1 || ei === -1) {
    try { return JSON.parse(text) as T; } catch { return null; }
  }
  try { return JSON.parse(text.slice(si + start.length, ei).trim()) as T; } catch { return null; }
}

// ── Exploit output parsing & artifact collection ──────────────────

/** Shape of the JSON block emitted by the exploit-generator skill. */
export interface ExploitResultJson {
  check_id:    string;
  finding_id?: string;
  language?:   string;
  subskill?:   string;
  result:      'EXPLOIT_SUCCESS' | 'EXPLOIT_FAILURE' | string;
  /** Directory that contains report.md, result.txt, and error.txt. */
  report_dir?: string;
  /** Absolute path to result.txt — used to derive report_dir when report_dir is absent. */
  result_file?: string;
  attempts?:   number;
}

/** Paths to artifacts after they have been copied into `destDir`. */
export interface ExploitArtifactPaths {
  report:  string | null;   // report.md
  result:  string | null;   // result.txt
  error:   string | null;   // error.txt
  payload: string | null;   // payload.py
  exploit: string | null;   // exploit.py
}

/**
 * Parse the `<<<EXPLOIT_RESULT_JSON>>>` block from exploit-generator output.
 * Returns null if the block is absent or malformed.
 */
export function parseExploitResult(text: string): ExploitResultJson | null {
  return extractJsonBlock<ExploitResultJson>(text, 'EXPLOIT_RESULT_JSON');
}

/**
 * Copy report.md, result.txt, and error.txt from `result.report_dir` into `destDir`.
 */
export async function collectExploitArtifacts(
  result: ExploitResultJson,
  destDir: string,
  log: PipelineLogger = noopLogger,
): Promise<ExploitArtifactPaths> {
  const paths: ExploitArtifactPaths = { report: null, result: null, error: null, payload: null, exploit: null };

  const reportDir =
    result.report_dir ??
    (result.result_file ? path.dirname(result.result_file) : undefined) ??
    (result.finding_id ? `/tmp/poc-run-${result.finding_id}` : undefined);
  if (!reportDir) {
    log.warn('report_dir missing from exploit result — no artifacts to collect');
    return paths;
  }
  if (!result.report_dir && !result.result_file) {
    log.warn(`report_dir derived from finding_id fallback: ${reportDir}`);
  }

  await mkdir(destDir, { recursive: true });

  const files: Array<[keyof ExploitArtifactPaths, string]> = [
    ['report', 'report.md'],
    ['result', 'result.txt'],
    ['error',  'error.txt'],
    ['payload',  'payload.py'],
    ['exploit',  'exploit.py'],
  ];

  for (const [key, filename] of files) {
    const src = path.join(reportDir, filename);
    if (existsSync(src)) {
      const dest = path.join(destDir, filename);
      await copyFile(src, dest);
      paths[key] = dest;
      log.info(`Saved artifact: ${dest}`);
    } else {
      log.warn(`Artifact not found: ${src}`);
    }
  }

  return paths;
}

// ── collectArtifactsFromWorkspace ─────────────────────────────────

/**
 * Fallback artifact collector — used when the exploit skill exits without
 * writing a proper EXPLOIT_RESULT_JSON (e.g. SDK crash, partial run).
 * Scans `searchDir` and its immediate subdirectories for the five known
 * artifact filenames and copies any it finds into `destDir`.
 */
export async function collectArtifactsFromWorkspace(
  searchDir: string,
  destDir: string,
  log: PipelineLogger = noopLogger,
): Promise<ExploitArtifactPaths> {
  const paths: ExploitArtifactPaths = { report: null, result: null, error: null, payload: null, exploit: null };
  if (!existsSync(searchDir)) return paths;

  await mkdir(destDir, { recursive: true });

  const files: Array<[keyof ExploitArtifactPaths, string]> = [
    ['report',  'report.md'],
    ['result',  'result.txt'],
    ['error',   'error.txt'],
    ['payload', 'payload.py'],
    ['exploit', 'exploit.py'],
  ];

  // Search the directory itself plus immediate subdirectories
  const { readdir } = await import('fs/promises');
  const searchDirs = [searchDir];
  try {
    const entries = await readdir(searchDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) searchDirs.push(path.join(searchDir, e.name));
    }
  } catch { /* unreadable — skip */ }

  for (const [key, filename] of files) {
    for (const dir of searchDirs) {
      const src = path.join(dir, filename);
      if (existsSync(src)) {
        const dest = path.join(destDir, filename);
        await copyFile(src, dest).catch(() => {});
        paths[key] = dest;
        log.info(`Collected artifact (fallback): ${dest}`);
        break;
      }
    }
  }

  return paths;
}

// ── runCveScan ────────────────────────────────────────────────────

export interface CveScanOptions extends Pick<RunSkillOptions, 'cwd' | 'model' | 'apiKey' | 'debug' | 'onChunk'> {}

export interface CveScanResult {
  findings: VulnerabilityFinding[];
  drops: DroppedFinding[];
  rawOutput: string;
}

/**
 * Run the cve-pattern-hunter skill against a workspace and return parsed findings.
 * Used by both the BullMQ cveWorker and the CLI's `scan` command.
 */
export async function runCveScan(
  opts: CveScanOptions,
  log: PipelineLogger = noopLogger,
): Promise<CveScanResult> {
  const result = await runCursorSkill({
    skillPath: 'Follow the instructions in the "cve-pattern-hunter" skill to find the security vulnerabilities',
    cwd:       opts.cwd,
    model:     opts.model,
    apiKey:    opts.apiKey,
    debug:     opts.debug,
    onChunk:   opts.onChunk,
    onDebug:   opts.debug ? (msg) => log.info(`[cursor] ${msg}`) : undefined,
  });

  const findings = extractJsonBlock<VulnerabilityFinding[]>(result.text, 'CVE_HUNTER_FINDINGS_JSON') ?? [];
  const drops    = extractJsonBlock<DroppedFinding[]>(result.text, 'CVE_HUNTER_DROPS_JSON') ?? [];
  log.info(`CVE scan complete: ${findings.length} findings, ${drops.length} drops`);

  return { findings, drops, rawOutput: result.text };
}

// ── runExploitGen ─────────────────────────────────────────────────

export interface ExploitGenOptions extends Pick<RunSkillOptions, 'cwd' | 'model' | 'apiKey' | 'debug' | 'onChunk'> {
  /** JSON string describing the vulnerability (passed as prompt suffix). */
  vulnJson: string;
  /** Directory where artifact files (report.md, result.txt, error.txt) are copied. */
  destDir: string;
}

export interface ExploitGenResult {
  exploitResult: ExploitResultJson | null;
  artifacts: ExploitArtifactPaths;
  rawOutput: string;
}

/**
 * Run the exploit-generator skill for a single vulnerability, parse the result,
 * and collect artifact files into `destDir`.
 * Used by both the BullMQ exploitWorker and the CLI's `scan`/`exploit` commands.
 */
export async function runExploitGen(
  opts: ExploitGenOptions,
  log: PipelineLogger = noopLogger,
): Promise<ExploitGenResult> {
  const result = await runCursorSkill({
    skillPath:    'Follow the instructions in the "exploit-generator" skill to generate the exploit, don\'t try to find any other vulnerabilities. Provide the exploit for the vulnerability in the JSON format.',
    promptSuffix: opts.vulnJson,
    cwd:          opts.cwd,
    model:        opts.model,
    apiKey:       opts.apiKey,
    debug:        opts.debug,
    onChunk:      opts.onChunk,
    onDebug:      opts.debug ? (msg) => log.info(`[cursor] ${msg}`) : undefined,
  });

  const exploitResult = parseExploitResult(result.text);
  if (!exploitResult) {
    log.warn('<<<EXPLOIT_RESULT_JSON>>> block not found in exploit-generator output');
  } else {
    log.info(`Exploit result: ${exploitResult.result} (${exploitResult.attempts ?? '?'} attempts)`);
  }

  const artifacts = exploitResult
    ? await collectExploitArtifacts(exploitResult, opts.destDir, log)
    : { report: null, result: null, error: null, payload: null, exploit: null };

  return { exploitResult, artifacts, rawOutput: result.text };
}
