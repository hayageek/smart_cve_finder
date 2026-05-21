import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_HOST: z.string().default('redis'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  API_PORT: z.coerce.number().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  WORKSPACES_DIR: z.string().default('./data/workspaces'),
  REPORTS_DIR: z.string().default('./data/atlassian_reports'),
  LOGS_DIR: z.string().default('./data/logs'),
  SKILLS_REPO_URL: z.string().default('https://github.com/hayageek/security_skills'),
  CURSOR_AGENT_BIN: z.string().default('/usr/local/bin/cursor-agent'),
  CURSOR_AGENT_TIMEOUT_MS: z.coerce.number().default(300000),
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
