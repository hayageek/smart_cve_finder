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
import {
  CWE_CVSS_MAP,
  type DroppedFinding,
  type PackageType,
  type RegistryPackageType,
  type Severity,
  type VulnerabilityFinding,
} from '@secscan/shared';
import { runSemgrepScan } from '@secscan/cve-semgrep';
import { runCursorSkill } from './cursor-runner.js';
import type { RunSkillOptions } from './cursor-runner.js';

export type { VulnerabilityFinding, DroppedFinding };

const execFileAsync = promisify(execFile);

/**
 * Remove any prior content and recreate `destDir` with a write probe.
 * Avoids tar/npm extract failures when a leftover or root-owned directory exists
 * (common after failed jobs or Docker volume permission mismatches).
 */
export async function prepareDestDir(destDir: string, log: PipelineLogger = noopLogger): Promise<void> {
  if (existsSync(destDir)) {
    log.warn(`Clearing existing directory before acquire: ${destDir}`);
    await rm(destDir, { recursive: true, force: true });
  }
  await mkdir(destDir, { recursive: true, mode: 0o755 });
  const probe = path.join(destDir, '.write_probe');
  try {
    await writeFile(probe, '');
    await rm(probe, { force: true });
  } catch (err) {
    throw new Error(
      `Workspace ${destDir} is not writable (${err}). ` +
      `Check WORKSPACES_DIR permissions on the host volume (./volumes/workspaces).`,
    );
  }
}

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

export type ArchiveFormat = 'tgz' | 'zip' | 'gem';

export interface RegistryMeta {
  resolvedVersion: string;
  tarballUrl: string;
  repoUrl: string | null;
  archiveFormat: ArchiveFormat;
}

const REGISTRY_USER_AGENT = 'secscan-atlassian/1.0 (security-research)';

async function registryFetch(url: string): Promise<Response> {
  return fetch(url, { headers: { 'User-Agent': REGISTRY_USER_AGENT } });
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
    archiveFormat: 'tgz',
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
  const repoUrl = normaliseRepoUrl(
    meta.info.project_urls?.['Source'] ??
      meta.info.project_urls?.['Repository'] ??
      meta.info.project_urls?.['Homepage'] ??
      meta.info.home_page,
  );
  return {
    resolvedVersion: meta.info.version,
    tarballUrl: sdist.url,
    repoUrl,
    archiveFormat: 'tgz',
  };
}

/** Fetch crates.io metadata for a crate version (default: latest). */
export async function resolveCargo(crateName: string, version?: string): Promise<RegistryMeta> {
  const base = `https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}`;
  const url = version ? `${base}/${encodeURIComponent(version)}` : base;
  const res = await registryFetch(url);
  if (!res.ok) {
    if (res.status === 404) throw new Error(`cargo crate "${crateName}" not found`);
    throw new Error(`crates.io error ${res.status}`);
  }
  const data = (await res.json()) as {
    crate?: { max_version?: string; repository?: string };
    version?: {
      num: string;
      dl_path: string;
      crate?: { repository?: string };
    };
  };

  if (version) {
    const ver = data.version;
    if (!ver) throw new Error(`cargo crate "${crateName}@${version}" not found`);
    return {
      resolvedVersion: ver.num,
      tarballUrl: `https://crates.io${ver.dl_path}`,
      repoUrl: normaliseRepoUrl(data.crate?.repository ?? ver.crate?.repository),
      archiveFormat: 'tgz',
    };
  }

  const resolvedVersion = data.crate?.max_version;
  if (!resolvedVersion) throw new Error(`cargo crate "${crateName}" has no published versions`);
  return resolveCargo(crateName, resolvedVersion);
}

/** Escape a Go module path for proxy.golang.org URLs (uppercase → !lowercase). */
export function escapeGoModulePath(modulePath: string): string {
  let out = '';
  for (const ch of modulePath) {
    if (ch >= 'A' && ch <= 'Z') out += `!${ch.toLowerCase()}`;
    else out += ch;
  }
  return out;
}

/** Infer a git repo URL from a Go module path when possible. */
export function repoUrlFromGoModule(modulePath: string): string | null {
  const parts = modulePath.split('/');
  if (parts.length < 3) return null;
  const host = parts[0];
  if (host === 'github.com' || host.endsWith('.github.com')) {
    return `https://${host}/${parts[1]}/${parts[2].replace(/\.git$/, '')}`;
  }
  if (host === 'gitlab.com' || host.endsWith('.gitlab.com')) {
    return `https://${host}/${parts[1]}/${parts[2].replace(/\.git$/, '')}`;
  }
  if (host === 'bitbucket.org') {
    return `https://${host}/${parts[1]}/${parts[2].replace(/\.git$/, '')}`;
  }
  return null;
}

function normaliseGoVersion(version?: string): string | undefined {
  if (!version || version.toLowerCase() === 'latest') return undefined;
  return version.startsWith('v') ? version : `v${version}`;
}

/** Fetch Go module metadata from proxy.golang.org (default: latest). */
export async function resolveGo(modulePath: string, version?: string): Promise<RegistryMeta> {
  const escaped = escapeGoModulePath(modulePath);
  let resolvedVersion = normaliseGoVersion(version);

  if (!resolvedVersion) {
    const res = await registryFetch(`https://proxy.golang.org/${escaped}/@latest`);
    if (!res.ok) {
      if (res.status === 404) throw new Error(`go module "${modulePath}" not found`);
      throw new Error(`Go proxy error ${res.status}`);
    }
    const meta = (await res.json()) as { Version: string };
    resolvedVersion = meta.Version;
  }

  const zipUrl = `https://proxy.golang.org/${escaped}/@v/${encodeURIComponent(resolvedVersion)}.zip`;
  return {
    resolvedVersion,
    tarballUrl: zipUrl,
    repoUrl: repoUrlFromGoModule(modulePath),
    archiveFormat: 'zip',
  };
}

/** Fetch RubyGems metadata for a gem version (default: latest). */
export async function resolveGem(gemName: string, version?: string): Promise<RegistryMeta> {
  if (version) {
    const url = `https://rubygems.org/api/v2/rubygems/${encodeURIComponent(gemName)}/versions/${encodeURIComponent(version)}.json`;
    const res = await registryFetch(url);
    if (!res.ok) {
      if (res.status === 404) throw new Error(`gem "${gemName}@${version}" not found`);
      throw new Error(`RubyGems error ${res.status}`);
    }
    const meta = (await res.json()) as {
      number: string;
      gem_uri: string;
      source_code_uri?: string;
      homepage_uri?: string;
    };
    return {
      resolvedVersion: meta.number,
      tarballUrl: meta.gem_uri,
      repoUrl: normaliseRepoUrl(meta.source_code_uri ?? meta.homepage_uri),
      archiveFormat: 'gem',
    };
  }

  const url = `https://rubygems.org/api/v1/gems/${encodeURIComponent(gemName)}.json`;
  const res = await registryFetch(url);
  if (!res.ok) {
    if (res.status === 404) throw new Error(`gem "${gemName}" not found`);
    throw new Error(`RubyGems error ${res.status}`);
  }
  const meta = (await res.json()) as {
    version: string;
    gem_uri: string;
    source_code_uri?: string;
    homepage_uri?: string;
  };
  return {
    resolvedVersion: meta.version,
    tarballUrl: meta.gem_uri,
    repoUrl: normaliseRepoUrl(meta.source_code_uri ?? meta.homepage_uri),
    archiveFormat: 'gem',
  };
}

/** Resolve registry metadata without downloading the package archive. */
export async function resolveRegistryPackage(
  packageType: RegistryPackageType,
  target: string,
  version?: string,
): Promise<RegistryMeta> {
  switch (packageType) {
    case 'npm':
      return resolveNpm(target, version);
    case 'pip':
      return resolvePip(target, version);
    case 'cargo':
      return resolveCargo(target, version);
    case 'go':
      return resolveGo(target, version);
    case 'gem':
      return resolveGem(target, version);
  }
}

/** Download a registry archive and extract it into destDir. */
export async function downloadAndExtract(
  archiveUrl: string,
  destDir: string,
  log: PipelineLogger = noopLogger,
  format: ArchiveFormat = 'tgz',
): Promise<void> {
  switch (format) {
    case 'tgz':
      return downloadTgz(archiveUrl, destDir, log);
    case 'zip':
      return downloadZip(archiveUrl, destDir, log);
    case 'gem':
      return downloadGem(archiveUrl, destDir, log);
  }
}

async function downloadArchiveToFile(archiveUrl: string, destPath: string, log: PipelineLogger): Promise<void> {
  log.info(`Downloading ${archiveUrl}`);
  const res = await fetch(archiveUrl, { headers: { 'User-Agent': REGISTRY_USER_AGENT } });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${archiveUrl}`);
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

async function copyExtractedTree(sourceRoot: string, destDir: string, log: PipelineLogger): Promise<void> {
  await prepareDestDir(destDir, log);
  for (const name of await readdir(sourceRoot)) {
    await cp(path.join(sourceRoot, name), path.join(destDir, name), { recursive: true });
  }
}

async function downloadTgz(tarballUrl: string, destDir: string, log: PipelineLogger): Promise<void> {
  const parentDir = path.dirname(destDir);
  const stamp = `${process.pid}_${Date.now()}`;
  const tmpTar = path.join(parentDir, `_dl_${stamp}.tgz`);
  const tmpExtract = path.join(parentDir, `_extract_${stamp}`);

  await downloadArchiveToFile(tarballUrl, tmpTar, log);
  log.info(`Extracting to ${destDir}`);
  try {
    await mkdir(tmpExtract, { recursive: true, mode: 0o755 });
    await execFileAsync('tar', ['-xzf', tmpTar, '-C', tmpExtract, '--strip-components=1']);
    await copyExtractedTree(tmpExtract, destDir, log);
  } finally {
    await rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
    await rm(tmpTar, { force: true }).catch(() => {});
  }
}

async function findZipExtractRoot(extractDir: string): Promise<string> {
  const entries = await readdir(extractDir, { withFileTypes: true });
  const versionDir = entries.find((e) => e.isDirectory() && e.name.includes('@v'));
  if (versionDir) return path.join(extractDir, versionDir.name);

  const dirs = entries.filter((e) => e.isDirectory());
  const files = entries.filter((e) => e.isFile());
  if (dirs.length === 1 && files.length === 0) {
    return findZipExtractRoot(path.join(extractDir, dirs[0]!.name));
  }
  return extractDir;
}

async function downloadZip(zipUrl: string, destDir: string, log: PipelineLogger): Promise<void> {
  const parentDir = path.dirname(destDir);
  const stamp = `${process.pid}_${Date.now()}`;
  const tmpZip = path.join(parentDir, `_dl_${stamp}.zip`);
  const tmpExtract = path.join(parentDir, `_extract_${stamp}`);

  await downloadArchiveToFile(zipUrl, tmpZip, log);
  log.info(`Extracting to ${destDir}`);
  try {
    await mkdir(tmpExtract, { recursive: true, mode: 0o755 });
    await execFileAsync('unzip', ['-q', tmpZip, '-d', tmpExtract]);
    const sourceRoot = await findZipExtractRoot(tmpExtract);
    await copyExtractedTree(sourceRoot, destDir, log);
  } finally {
    await rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
    await rm(tmpZip, { force: true }).catch(() => {});
  }
}

async function downloadGem(gemUrl: string, destDir: string, log: PipelineLogger): Promise<void> {
  const parentDir = path.dirname(destDir);
  const stamp = `${process.pid}_${Date.now()}`;
  const tmpGem = path.join(parentDir, `_dl_${stamp}.gem`);
  const tmpOuter = path.join(parentDir, `_gem_${stamp}`);
  const tmpExtract = path.join(parentDir, `_extract_${stamp}`);

  await downloadArchiveToFile(gemUrl, tmpGem, log);
  log.info(`Extracting to ${destDir}`);
  try {
    await mkdir(tmpOuter, { recursive: true, mode: 0o755 });
    await execFileAsync('tar', ['-xf', tmpGem, '-C', tmpOuter]);
    const dataTarGz = path.join(tmpOuter, 'data.tar.gz');
    if (!existsSync(dataTarGz)) throw new Error(`Invalid gem archive: missing data.tar.gz (${gemUrl})`);
    await mkdir(tmpExtract, { recursive: true, mode: 0o755 });
    await execFileAsync('tar', ['-xzf', dataTarGz, '-C', tmpExtract]);
    await copyExtractedTree(tmpExtract, destDir, log);
  } finally {
    await rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
    await rm(tmpOuter, { recursive: true, force: true }).catch(() => {});
    await rm(tmpGem, { force: true }).catch(() => {});
  }
}

// ── acquireSource ─────────────────────────────────────────────────

export type { PackageType };

export interface AcquireOptions {
  packageType: PackageType;
  /** Git URL (git type) or package name / module path (registry). */
  target: string;
  version?: string;
  destDir: string;
  gitDepth?: number;
}

export interface AcquireResult {
  resolvedVersion?: string;
  repoUrl?: string | null;
  tarballUrl?: string | null;
  /** True when the source is private / inaccessible — caller should mark it so. */
  isPrivate?: boolean;
}

/**
 * Acquire source code into `destDir`:
 *  - git    → shallow clone
 *  - npm    → resolve registry + download tarball
 *  - pip    → resolve PyPI + download sdist tarball
 *  - cargo  → resolve crates.io + download .crate tarball
 *  - go     → resolve Go proxy + download module zip
 *  - gem    → resolve RubyGems + download .gem archive
 */
export async function acquireSource(
  opts: AcquireOptions,
  log: PipelineLogger = noopLogger,
): Promise<AcquireResult> {
  const { packageType, target, version, destDir, gitDepth = 1 } = opts;

  if (packageType !== 'git') {
    log.info(`Resolving ${packageType} package: ${target}${version ? `@${version}` : ''}`);
    const meta = await resolveRegistryPackage(packageType, target, version);
    log.info(`Resolved ${target}@${meta.resolvedVersion} — ${meta.tarballUrl}`);
    if (meta.repoUrl) log.info(`Repository: ${meta.repoUrl}`);
    await downloadAndExtract(meta.tarballUrl, destDir, log, meta.archiveFormat);
    return { resolvedVersion: meta.resolvedVersion, repoUrl: meta.repoUrl, tarballUrl: meta.tarballUrl };
  }

  // git — destination must be empty (clone fails otherwise)
  log.info(`Cloning ${target}`);
  await prepareDestDir(destDir, log);
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

const SEVERITIES = new Set<Severity>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

function severityFromCvss(score: number): Severity {
  if (score >= 9.0) return 'CRITICAL';
  if (score >= 7.0) return 'HIGH';
  if (score >= 4.0) return 'MEDIUM';
  return 'LOW';
}

function parseSeverity(value: unknown): Severity | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.toUpperCase() as Severity;
  return SEVERITIES.has(upper) ? upper : undefined;
}

/** Flatten finding-shaped drop JSON (extra/start/end) into DroppedFinding. */
export function normalizeDroppedFinding(raw: Record<string, unknown>): DroppedFinding {
  const extra = raw.extra as Record<string, unknown> | undefined;
  const meta = (raw.metadata ?? extra?.metadata) as Record<string, unknown> | undefined;
  const start = raw.start as { line?: number } | undefined;
  const end = raw.end as { line?: number } | undefined;
  const cwe = String(raw.cwe ?? meta?.cwe ?? 'UNKNOWN');
  const dropReason = String(raw.drop_reason ?? '');

  let severity =
    parseSeverity(raw.severity) ??
    parseSeverity(extra?.severity);

  if (!severity) {
    const cvss = CWE_CVSS_MAP[cwe];
    if (cvss != null) {
      severity = severityFromCvss(cvss);
    } else if (dropReason.includes('severity-below-high')) {
      // Skill drops MEDIUM/LOW at Step 4 — default to MEDIUM, not LOW.
      severity = 'MEDIUM';
    } else {
      severity = 'LOW';
    }
  }

  const vulnType = raw.vulnerability_type ?? meta?.vulnerability_type;
  const message = raw.message ?? extra?.message;

  return {
    check_id: String(raw.check_id ?? ''),
    path: String(raw.path ?? ''),
    line: Number(raw.line ?? start?.line ?? 0),
    ...(raw.line_end != null || end?.line != null
      ? { line_end: Number(raw.line_end ?? end?.line) }
      : {}),
    severity,
    cwe,
    ...(vulnType ? { vulnerability_type: String(vulnType) } : {}),
    ...(message ? { message: String(message) } : {}),
    ...(meta ? { metadata: meta } : {}),
    ...(extra ? { extra: extra as DroppedFinding['extra'] } : {}),
    ...(start ? { start: start as DroppedFinding['start'] } : {}),
    ...(end ? { end: end as DroppedFinding['end'] } : {}),
    drop_reason: dropReason,
    drop_evidence: String(raw.drop_evidence ?? ''),
  };
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
  report:          string | null;   // report.md
  result:          string | null;   // result.txt
  error:           string | null;   // error.txt
  payload:         string | null;   // payload.py
  exploit:         string | null;   // exploit.py
  runScript:       string | null;   // run.sh
  dockerRunScript: string | null;   // docker_run_script.sh
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
  const paths: ExploitArtifactPaths = {
    report: null, result: null, error: null, payload: null, exploit: null, runScript: null, dockerRunScript: null,
  };

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

  // Required artifacts — warn if missing (indicates skill output is incomplete)
  const required: Array<[keyof ExploitArtifactPaths, string]> = [
    ['report', 'report.md'],
    ['result', 'result.txt'],
  ];
  // Optional artifacts — only produced in certain outcomes, absence is normal
  const optional: Array<[keyof ExploitArtifactPaths, string]> = [
    ['error',           'error.txt'],            // written only when exploit fails
    ['payload',         'payload.py'],           // written only when a payload is generated
    ['exploit',         'exploit.py'],           // written only when a full exploit is generated
    ['runScript',       'run.sh'],               // install + execute harness
    ['dockerRunScript', 'docker_run_script.sh'], // written only for Docker-based PoC runs
  ];

  for (const [key, filename] of required) {
    const src = path.join(reportDir, filename);
    if (existsSync(src)) {
      const dest = path.join(destDir, filename);
      await copyFile(src, dest);
      paths[key] = dest;
      log.info(`Saved artifact: ${dest}`);
    } else {
      log.warn(`Expected artifact not found: ${src}`);
    }
  }

  for (const [key, filename] of optional) {
    const src = path.join(reportDir, filename);
    if (existsSync(src)) {
      const dest = path.join(destDir, filename);
      await copyFile(src, dest);
      paths[key] = dest;
      log.info(`Saved artifact: ${dest}`);
    }
    // Missing optional artifacts are normal — no warning
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
  const paths: ExploitArtifactPaths = {
    report: null, result: null, error: null, payload: null, exploit: null, runScript: null, dockerRunScript: null,
  };
  if (!existsSync(searchDir)) return paths;

  await mkdir(destDir, { recursive: true });

  const files: Array<[keyof ExploitArtifactPaths, string]> = [
    ['report',          'report.md'],
    ['result',          'result.txt'],
    ['error',           'error.txt'],
    ['payload',         'payload.py'],
    ['exploit',         'exploit.py'],
    ['runScript',       'run.sh'],
    ['dockerRunScript', 'docker_run_script.sh'],
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

/** Empty cve-pattern-hunter JSON blocks returned when the Semgrep gate skips the agent. */
export const EMPTY_CVE_SCAN_OUTPUT =
  '<<<CVE_HUNTER_FINDINGS_JSON>>>\n[]\n<<<END_CVE_HUNTER_FINDINGS_JSON>>>\n' +
  '<<<CVE_HUNTER_DROPS_JSON>>>\n[]\n<<<END_CVE_HUNTER_DROPS_JSON>>>';

export interface CveScanOptions extends Pick<RunSkillOptions, 'cwd' | 'model' | 'modelFast' | 'apiKey' | 'debug' | 'onChunk'> {
  /** Run the Semgrep candidate scan before the agent (default: true). */
  semgrepEnabled?: boolean;
  /** Semgrep binary (default: semgrep). */
  semgrepBin?: string;
  /** Parallelism passed to `semgrep --jobs`. */
  semgrepJobs?: number;
}

export interface CveScanResult {
  findings: VulnerabilityFinding[];
  drops: DroppedFinding[];
  rawOutput: string;
}

/**
 * Run the cve-pattern-hunter skill against a workspace and return parsed findings.
 *
 * Semgrep is the mandatory front gate: it enumerates candidate sinks and is the
 * required input for the cve-pattern-hunter skill. **If Semgrep produces no
 * matches the cursor scan does not run** — the skill has nothing to verify.
 *
 * Used by both the BullMQ scanWorker and the CLI's `scan` command.
 */
export async function runCveScan(
  opts: CveScanOptions,
  log: PipelineLogger = noopLogger,
): Promise<CveScanResult> {
  const semgrepOn = opts.semgrepEnabled !== false;

  if (!semgrepOn) {
    log.warn('Semgrep gate disabled — no candidate list to verify; skipping cve-pattern-hunter');
    return { findings: [], drops: [], rawOutput: EMPTY_CVE_SCAN_OUTPUT };
  }

  const semgrep = await runSemgrepScan({
    cwd: opts.cwd,
    semgrepBin: opts.semgrepBin,
    jobs: opts.semgrepJobs,
  });

  if (semgrep.skippedReason) {
    log.warn(`Semgrep scan: ${semgrep.skippedReason}`);
  }

  if (semgrep.matches.length === 0) {
    log.info(
      `Semgrep scan: no candidate sinks (scanned languages: ${semgrep.languagesScanned.join(', ') || 'none'}); skipping cve-pattern-hunter`,
    );
    return { findings: [], drops: [], rawOutput: EMPTY_CVE_SCAN_OUTPUT };
  }

  const sample = semgrep.matches
    .slice(0, 3)
    .map((m) => `${m.file}:${m.line} (${m.language}/${m.patternId})`)
    .join('; ');
  log.info(`Semgrep scan: ${semgrep.matches.length} candidate(s) — ${sample}${semgrep.matches.length > 3 ? '…' : ''}`);

  // The cve-pattern-hunter skill is driven entirely by the Semgrep candidate
  // list — pass it verbatim as the prompt suffix so the agent only verifies
  // these sinks instead of re-enumerating them.
  const candidateJson = JSON.stringify(
    { matches: semgrep.matches, languagesScanned: semgrep.languagesScanned },
    null,
    2,
  );

  const result = await runCursorSkill({
    skillPath:
      `Follow the "cve-pattern-hunter" skill instructions to verify the Semgrep candidate vulnerabilities below and prune false positives.\n` +
      `Workspace: ${opts.cwd}\n` +
      `Semgrep candidate list:`,
    promptSuffix: candidateJson,
    cwd:       opts.cwd,
    model:     opts.model,
    modelFast: opts.modelFast,
    apiKey:    opts.apiKey,
    debug:     opts.debug,
    onChunk:   opts.onChunk,
    onDebug: (msg) => log.info(`[cursor] ${msg}`),
  });

  const findings = extractJsonBlock<VulnerabilityFinding[]>(result.text, 'CVE_HUNTER_FINDINGS_JSON') ?? [];
  const rawDrops = extractJsonBlock<Record<string, unknown>[]>(result.text, 'CVE_HUNTER_DROPS_JSON') ?? [];
  const drops = rawDrops.map(normalizeDroppedFinding);
  log.info(`CVE scan complete: ${findings.length} findings, ${drops.length} drops`);

  return { findings, drops, rawOutput: result.text };
}

// ── runExploitGen ─────────────────────────────────────────────────

export interface ExploitGenOptions extends Pick<RunSkillOptions, 'cwd' | 'model' | 'modelFast' | 'apiKey' | 'debug' | 'onChunk'> {
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
  const skillPath =
    `Follow the "exploit-generator" skill instructions to generate an exploit for the vulnerability below.\n` +
    `Workspace: ${opts.cwd}\n` +
    `Vulnerability details:`;

  const result = await runCursorSkill({
    skillPath,
    promptSuffix: opts.vulnJson,
    cwd:          opts.cwd,
    model:        opts.model,
    modelFast:    opts.modelFast,
    apiKey:       opts.apiKey,
    debug:        opts.debug,
    onChunk:      opts.onChunk,
    onDebug: (msg) => log.info(`[cursor] ${msg}`),
  });

  const exploitResult = parseExploitResult(result.text);
  if (!exploitResult) {
    log.warn('<<<EXPLOIT_RESULT_JSON>>> block not found in exploit-generator output');
  } else {
    log.info(`Exploit result: ${exploitResult.result} (${exploitResult.attempts ?? '?'} attempts)`);
  }

  const artifacts = exploitResult
    ? await collectExploitArtifacts(exploitResult, opts.destDir, log)
    : {
        report: null, result: null, error: null, payload: null, exploit: null, runScript: null, dockerRunScript: null,
      };

  return { exploitResult, artifacts, rawOutput: result.text };
}
