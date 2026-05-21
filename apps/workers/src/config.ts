import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_HOST: z.string().default('redis'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  WORKSPACES_DIR: z.string().default('./data/workspaces'),
  REPORTS_DIR: z.string().default('./data/atlassian_reports'),
  LOGS_DIR: z.string().default('./data/logs'),
  // Local directory containing the pre-cloned security skills (cve-pattern-hunter, exploit-generator).
  // Takes precedence over SKILLS_REPO_URL — if the directory exists, no git clone is performed.
  SKILLS_DIR: z.string().default('/data/skills'),
  SKILLS_REPO_URL: z.string().default('https://github.com/hayageek/security_skills'),
  // Timeout (ms) for a single @cursor/sdk Agent.prompt() call
  CURSOR_AGENT_TIMEOUT_MS: z.coerce.number().default(300000),
  // Model passed to @cursor/sdk Agent.prompt(); use "composer-latest" or a specific model ID.
  CURSOR_AGENT_MODEL: z.string().default('claude-sonnet-4-5'),
  CURSOR_API_KEY: z.string().optional(),
  // Set to "true" to log the full prompt and result text from @cursor/sdk calls
  DEBUG_CURSOR: z.string().transform((v) => v === 'true').default('false'),
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
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment variables:\n', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;


export const redisOptions = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  ...(config.REDIS_PASSWORD ? { password: config.REDIS_PASSWORD } : {}),
  maxRetriesPerRequest: null,
};
