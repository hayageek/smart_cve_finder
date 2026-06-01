export type EcosystemId = 'npm' | 'pypi' | 'maven' | 'go' | 'php' | 'ruby' | 'rust';

export const ALL_ECOSYSTEMS: EcosystemId[] = ['npm', 'pypi', 'maven', 'go', 'php', 'ruby', 'rust'];

export type SourceMode = 'auto' | 'libraries-io' | 'native';

export type FetchProgress = (message: string) => void;

export interface TopPackageRow {
  rank: number;
  ecosystem: EcosystemId;
  name: string;
  version: string | null;
  repoUrl: string | null;
  homepage: string | null;
  license: string | null;
  downloads: number | null;
  dependents: number | null;
  stars: number | null;
}
