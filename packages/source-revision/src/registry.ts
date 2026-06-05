import type { RegistryPackageType } from '@secscan/shared';
import type { RemoteRevision, RevisionLookupResult } from './types.js';

const REGISTRY_USER_AGENT = 'secscan-atlassian/1.0 (security-research)';

async function registryFetch(url: string): Promise<Response> {
  return fetch(url, { headers: { 'User-Agent': REGISTRY_USER_AGENT } });
}

function packageRevision(version: string): RemoteRevision {
  return { revision: version, kind: 'package-version', label: version };
}

async function resolveNpmVersion(name: string, version?: string): Promise<RevisionLookupResult> {
  const tag = version ?? 'latest';
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${tag}`;
  const res = await registryFetch(url);
  if (!res.ok) return { ok: false, error: `npm registry ${res.status} for ${name}@${tag}` };
  const meta = (await res.json()) as { version?: string };
  if (!meta.version) return { ok: false, error: `npm registry missing version for ${name}` };
  return { ok: true, remote: packageRevision(meta.version) };
}

async function resolvePipVersion(name: string, version?: string): Promise<RevisionLookupResult> {
  const suffix = version ? `/${encodeURIComponent(version)}` : '';
  const url = `https://pypi.org/pypi/${encodeURIComponent(name)}${suffix}/json`;
  const res = await registryFetch(url);
  if (!res.ok) return { ok: false, error: `PyPI ${res.status} for ${name}${version ? `@${version}` : ''}` };
  const meta = (await res.json()) as { info?: { version?: string } };
  const ver = meta.info?.version;
  if (!ver) return { ok: false, error: `PyPI missing version for ${name}` };
  return { ok: true, remote: packageRevision(ver) };
}

async function resolveCargoVersion(name: string, version?: string): Promise<RevisionLookupResult> {
  const base = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`;
  const url = version ? `${base}/${encodeURIComponent(version)}` : base;
  const res = await registryFetch(url);
  if (!res.ok) return { ok: false, error: `crates.io ${res.status} for ${name}` };
  const data = (await res.json()) as { crate?: { max_version?: string }; version?: { num?: string } };
  const ver = version ? data.version?.num : data.crate?.max_version;
  if (!ver) return { ok: false, error: `crates.io missing version for ${name}` };
  return { ok: true, remote: packageRevision(ver) };
}

function escapeGoModulePath(modulePath: string): string {
  let out = '';
  for (const ch of modulePath) {
    if (ch >= 'A' && ch <= 'Z') out += `!${ch.toLowerCase()}`;
    else out += ch;
  }
  return out;
}

function normaliseGoVersion(version?: string): string | undefined {
  if (!version || version.toLowerCase() === 'latest') return undefined;
  return version.startsWith('v') ? version : `v${version}`;
}

async function resolveGoVersion(modulePath: string, version?: string): Promise<RevisionLookupResult> {
  const escaped = escapeGoModulePath(modulePath);
  let resolved = normaliseGoVersion(version);
  if (!resolved) {
    const res = await registryFetch(`https://proxy.golang.org/${escaped}/@latest`);
    if (!res.ok) return { ok: false, error: `Go proxy ${res.status} for ${modulePath}` };
    const meta = (await res.json()) as { Version?: string };
    resolved = meta.Version;
  }
  if (!resolved) return { ok: false, error: `Go proxy missing version for ${modulePath}` };
  return { ok: true, remote: packageRevision(resolved) };
}

async function resolveGemVersion(name: string, version?: string): Promise<RevisionLookupResult> {
  if (version) {
    const url = `https://rubygems.org/api/v2/rubygems/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}.json`;
    const res = await registryFetch(url);
    if (!res.ok) return { ok: false, error: `RubyGems ${res.status} for ${name}@${version}` };
    const meta = (await res.json()) as { number?: string };
    if (!meta.number) return { ok: false, error: `RubyGems missing version for ${name}@${version}` };
    return { ok: true, remote: packageRevision(meta.number) };
  }
  const url = `https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`;
  const res = await registryFetch(url);
  if (!res.ok) return { ok: false, error: `RubyGems ${res.status} for ${name}` };
  const meta = (await res.json()) as { version?: string };
  if (!meta.version) return { ok: false, error: `RubyGems missing version for ${name}` };
  return { ok: true, remote: packageRevision(meta.version) };
}

export async function resolveRegistryRevision(
  packageType: RegistryPackageType,
  packageName: string,
  packageVersion?: string,
): Promise<RevisionLookupResult> {
  switch (packageType) {
    case 'npm':
      return resolveNpmVersion(packageName, packageVersion);
    case 'pip':
      return resolvePipVersion(packageName, packageVersion);
    case 'cargo':
      return resolveCargoVersion(packageName, packageVersion);
    case 'go':
      return resolveGoVersion(packageName, packageVersion);
    case 'gem':
      return resolveGemVersion(packageName, packageVersion);
  }
}
