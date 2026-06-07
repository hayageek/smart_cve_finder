import { writeFileSync } from 'fs';
import type { RepoRow } from './types.js';

const COLUMNS: (keyof RepoRow)[] = [
  'program',
  'org',
  'repo_name',
  'full_name',
  'clone_url',
  'html_url',
  'default_branch',
  'pushed_at',
  'updated_at',
  'stars',
  'forks',
  'language',
  'archived',
  'fork',
  'private',
];

function escapeCsv(value: string | number | boolean): string {
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function writeCsv(path: string, rows: RepoRow[]): void {
  const lines = [COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(COLUMNS.map((col) => escapeCsv(row[col])).join(','));
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

export function repoToRow(program: string, org: string, repo: {
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
}): RepoRow {
  return {
    program,
    org,
    repo_name: repo.name,
    full_name: repo.full_name,
    clone_url: repo.clone_url,
    html_url: repo.html_url,
    default_branch: repo.default_branch ?? '',
    pushed_at: repo.pushed_at ?? '',
    updated_at: repo.updated_at ?? '',
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    language: repo.language ?? '',
    archived: repo.archived ?? false,
    fork: repo.fork ?? false,
    private: repo.private ?? false,
  };
}
