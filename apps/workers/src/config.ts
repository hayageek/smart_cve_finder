import 'dotenv/config';
import path from 'path';
import { mkdirSync } from 'fs';
import { z } from 'zod';

/**
 * Resolve a path to absolute. Relative paths are resolved against process.cwd()
 * at module load. Centralising this here means every consumer (workers, CLI,
 * cursor-runner) sees the same absolute paths — preventing the class of bugs
 * where the Cursor SDK's agent process resolves a relative cwd against its own
 * working directory and ends up scanning unintended files.
 */
const absolutePath = (defaultRel: string) =>
  z.string().default(defaultRel).transform((p) => path.resolve(p));

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_HOST: z.string().default('redis'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  WORKSPACES_DIR: absolutePath('./data/workspaces'),
  REPORTS_DIR:    absolutePath('./data/atlassian_reports'),
  LOGS_DIR:       absolutePath('./data/logs'),
  // Local directory containing the pre-cloned security skills (cve-pattern-hunter, exploit-generator).
  // Takes precedence over SKILLS_REPO_URL — if the directory exists, no git clone is performed.
  SKILLS_DIR:     absolutePath('/data/skills'),
  SKILLS_REPO_URL: z.string().default('https://github.com/hayageek/security_skills'),
  // Timeout (ms) for a single @cursor/sdk Agent.prompt() call
  CURSOR_AGENT_TIMEOUT_MS: z.coerce.number().default(300000),
  // Model passed to @cursor/sdk Agent.create(); use "composer-latest" or a specific model ID.
  CURSOR_AGENT_MODEL: z.string().default('claude-sonnet-4-5'),
  // Composer 2.5 tier: false = standard (cheaper), true = fast (SDK default when omitted).
  CURSOR_AGENT_MODEL_FAST: z.string().transform((v) => v === 'true').default('false'),
  CURSOR_API_KEY: z.string().optional(),
  // Set to "true" to log the full prompt and result text from @cursor/sdk calls
  DEBUG_CURSOR: z.string().transform((v) => v === 'true').default('false'),
  // Semgrep candidate gate before cve-pattern-hunter (requires `semgrep` on PATH).
  // No Semgrep matches → cve-pattern-hunter (cursor scan) is skipped entirely.
  CVE_SEMGREP_ENABLED: z.string().transform((v) => v !== 'false').default('true'),
  CVE_SEMGREP_BIN: z.string().default('semgrep'),
  CVE_SEMGREP_JOBS: z.coerce.number().optional(),
  SECRET_GITLEAKS_BIN: z.string().default('gitleaks'),
  SECRET_TRUFFLEHOG_BIN: z.string().default('trufflehog'),
  /** Minimum secret severity to keep (CRITICAL/HIGH/MEDIUM/LOW). Set MEDIUM to drop LOW-only hits. */
  SECRET_MIN_SEVERITY: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
  /** When true, skip the Cursor triage skill — gitleaks + TruffleHog only. Unverified hits are kept as findings. */
  SECRET_GATE_ONLY: z.string().transform((v) => v === 'true').default('false'),
  /** When true, mask secret values in DB and gitleaks report. Default false (full values stored). */
  SECRET_REDACT: z.string().transform((v) => v === 'true').default('false'),
  SCANNER_CONCURRENCY: z.coerce.number().default(3),
  SCANNER_MAX_ATTEMPTS: z.coerce.number().default(2),
  SCANNER_BACKOFF_DELAY_MS: z.coerce.number().default(10000),
  SCAN_DEDUP_WINDOW_HOURS: z.coerce.number().default(24),
  WORKSPACE_CLEANUP_AFTER_HOURS: z.coerce.number().default(48),
  EXPLOIT_CONCURRENCY: z.coerce.number().default(2),
  EXPLOIT_MAX_ATTEMPTS: z.coerce.number().default(2),
  EXPLOIT_BACKOFF_DELAY_MS: z.coerce.number().default(10000),
  EXPLOIT_MIN_SEVERITY: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).default('HIGH'),
  EXPLOIT_INCLUDE_DROPPED: z.string().transform((v) => v === 'true').default('false'),
  GIT_CLONE_DEPTH: z.coerce.number().default(1),
  NOTIFY_WEBHOOK_URL: z.string().optional(),
  NOTIFY_ON_CRITICAL: z.string().transform((v) => v !== 'false').default('true'),
  NOTIFY_ON_SCAN_COMPLETE: z.string().transform((v) => v === 'true').default('false'),
  GITHUB_TOKEN: z.string().optional(),
  /** Minimum GitHub stars to run a scan; 0 disables the check. */
  SCAN_MIN_STARS: z.coerce.number().default(100),
  /** When true, skip GitHub repos without private vulnerability reporting enabled. */
  SCAN_REQUIRE_PVR: z.string().transform((v) => v === 'true').default('false'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:\n', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;

// ── Path pre-flight ──────────────────────────────────────────────
// Create the data directories up-front so the workers fail loudly at
// startup (instead of silently mkdir-ing them later from inside a job).
// Also surface the resolved paths to stderr so an operator can immediately
// spot a misconfigured WORKSPACES_DIR (e.g. one that points outside the
// project root) before the first scan runs.
for (const [name, dir] of [
  ['WORKSPACES_DIR', config.WORKSPACES_DIR],
  ['REPORTS_DIR',    config.REPORTS_DIR],
  ['LOGS_DIR',       config.LOGS_DIR],
] as const) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(`Failed to create ${name} at ${dir}:`, err);
    process.exit(1);
  }
}

if (process.env.DEBUG_CONFIG_PATHS !== 'false') {
  process.stderr.write(
    `[config] paths resolved (processCwd=${process.cwd()})\n` +
    `[config]   WORKSPACES_DIR = ${config.WORKSPACES_DIR}\n` +
    `[config]   REPORTS_DIR    = ${config.REPORTS_DIR}\n` +
    `[config]   LOGS_DIR       = ${config.LOGS_DIR}\n` +
    `[config]   SKILLS_DIR     = ${config.SKILLS_DIR}\n`,
  );
}

export const redisOptions = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  ...(config.REDIS_PASSWORD ? { password: config.REDIS_PASSWORD } : {}),
  maxRetriesPerRequest: null,
};
