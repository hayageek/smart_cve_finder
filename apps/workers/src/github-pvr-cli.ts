#!/usr/bin/env node

/**
 * Check whether private vulnerability reporting is enabled (Security tab → Report a vulnerability).
 *
 * Usage:
 *   npm run github-pvr -- owner/repo
 *   npm run github-pvr -- https://github.com/owner/repo
 *   npm run github-pvr -- owner/repo --json
 *
 * GITHUB_TOKEN is optional; unauthenticated requests work for public repos (lower rate limit).
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPrivateVulnerabilityReportingStatus } from '@secscan/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function parseOwnerRepo(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim();
  const slash = trimmed.match(/^([^/]+)\/([^/]+)$/);
  if (slash) {
    return { owner: slash[1], repo: slash[2].replace(/\.git$/, '') };
  }
  const url = trimmed.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (url) {
    return { owner: url[1], repo: url[2] };
  }
  return null;
}

function printUsage(): void {
  console.error(`Usage:
  npm run github-pvr -- <owner/repo|https://github.com/owner/repo> [--json]

Examples:
  npm run github-pvr -- expressjs/express
  npm run github-pvr -- https://github.com/octocat/Hello-World --json
`);
}

async function main(): Promise<void> {
  const wantJson = process.argv.includes('--json');
  const args = process.argv.slice(2).filter((a) => a !== '--json');

  if (args.length < 1) {
    printUsage();
    process.exit(1);
  }

  const parsed = parseOwnerRepo(args[0]);
  if (!parsed) {
    console.error(`Invalid repository: ${args[0]}`);
    printUsage();
    process.exit(1);
  }

  const { owner, repo } = parsed;
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const token = process.env.GITHUB_TOKEN;

  const result = await getPrivateVulnerabilityReportingStatus(repoUrl, { token });

  if (!result.ok) {
    if (result.code === 'not_found') {
      console.error(`Repository not found: ${owner}/${repo}`);
    } else {
      console.error(
        `GitHub API error (${result.code}): ${result.message || 'unknown'}`,
      );
    }
    process.exit(1);
  }

  const { enabled } = result;

  if (wantJson) {
    console.log(
      JSON.stringify(
        { owner, repo, private_vulnerability_reporting_enabled: enabled },
        null,
        2,
      ),
    );
  } else {
    console.log(`${owner}/${repo}`);
    console.log(`  private vulnerability reporting: ${enabled ? 'enabled' : 'disabled'}`);
    console.log(
      '  (When enabled, reporters can use "Report a vulnerability" on the Security tab for this repo.)',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
