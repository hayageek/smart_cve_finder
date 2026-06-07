export interface ProgramConfig {
  name: string;
  orgs: string[];
}

export interface ProgramsFile {
  programs: ProgramConfig[];
}

export interface GitHubRepo {
  name: string;
  full_name: string;
  clone_url: string;
  html_url: string;
  default_branch: string;
  pushed_at: string;
  updated_at: string;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  archived: boolean;
  fork: boolean;
  private: boolean;
}

export interface OrgCacheEntry {
  org: string;
  fetchedAt: string;
  cutoffDate: string;
  totalCount: number;
  truncated: boolean;
  repos: GitHubRepo[];
  skipped?: boolean;
  skipReason?: string;
}

export interface OrgFetchResult {
  repos: GitHubRepo[];
  totalCount: number;
  truncated: boolean;
  skipped?: boolean;
  skipReason?: string;
}

export interface RepoRow {
  program: string;
  org: string;
  repo_name: string;
  full_name: string;
  clone_url: string;
  html_url: string;
  default_branch: string;
  pushed_at: string;
  updated_at: string;
  stars: number;
  forks: number;
  language: string;
  archived: boolean;
  fork: boolean;
  private: boolean;
}

export interface CliOptions {
  programsPath: string;
  outputPath: string;
  cacheDir: string;
  days: number;
  force: boolean;
  forceOrgs: Set<string>;
  verbose: boolean;
}
