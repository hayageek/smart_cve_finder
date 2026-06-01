import { librariesIoKey } from '../config.js';
import type { EcosystemId, FetchProgress, SourceMode, TopPackageRow } from '../types.js';
import { fetchTopFromLibrariesIo } from './libraries-io.js';
import { fetchTopPypi } from './native-pypi.js';
import { fetchTopPackagist } from './native-packagist.js';
import { fetchTopCargo } from './native-cargo.js';

const NATIVE_ECOSYSTEMS = new Set<EcosystemId>(['pypi', 'php', 'rust']);

export function resolveSourceMode(ecosystem: EcosystemId, mode: SourceMode): SourceMode {
  if (mode !== 'auto') return mode;
  // Prefer native download lists for PyPI/Packagist/Cargo (no libraries.io quota).
  if (NATIVE_ECOSYSTEMS.has(ecosystem)) return 'native';
  if (librariesIoKey()) return 'libraries-io';
  return 'libraries-io';
}

export async function fetchTopPackages(
  ecosystem: EcosystemId,
  limit: number,
  mode: SourceMode,
  onProgress?: FetchProgress,
): Promise<TopPackageRow[]> {
  const resolved = resolveSourceMode(ecosystem, mode);

  if (resolved === 'libraries-io') {
    return fetchTopFromLibrariesIo(ecosystem, limit, onProgress);
  }

  switch (ecosystem) {
    case 'pypi':
      return fetchTopPypi(limit, onProgress);
    case 'php':
      return fetchTopPackagist(limit, onProgress);
    case 'rust':
      return fetchTopCargo(limit, onProgress);
    default:
      throw new Error(
        `${ecosystem}: native source unavailable. Set LIBRARIES_IO_KEY in top_packages/.env or use --source libraries-io.`,
      );
  }
}
