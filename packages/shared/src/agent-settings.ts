/**
 * Resolve which agent runner a scan uses, and the optional OpenAI-compatible
 * proxy settings for the Claude runner.
 *
 * A database value wins over the environment. Null means "use the environment".
 * An empty string for the proxy URL or API key means "do not send that variable",
 * even when the environment has one.
 */

export type AgentRunner = 'cursor' | 'claude';

export interface AgentSettingsRow {
  agentRunner?: string | null;
  claudeAgentModel?: string | null;
  anthropicBaseUrl?: string | null;
  anthropicApiKey?: string | null;
}

export interface AgentEnvDefaults {
  runner?: string | null;
  claudeModel?: string | null;
  cursorModel: string;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export interface ResolvedAgentSettings {
  runner: AgentRunner;
  /** Model id for the selected runner. */
  model: string;
  /** Claude-runner model, even when the active runner is Cursor. */
  claudeModel: string;
  anthropicBaseUrl?: string;
  anthropicApiKey?: string;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionalOverride(
  dbValue: string | null | undefined,
  envValue: string | null | undefined,
): string | undefined {
  // null/undefined → inherit env. Whitespace-only / "" in DB → inherit env (legacy saves).
  if (dbValue == null) return nonEmpty(envValue);
  const fromDb = nonEmpty(dbValue);
  if (fromDb !== undefined) return fromDb;
  return nonEmpty(envValue);
}

export function resolveAgentSettings(
  row: AgentSettingsRow | null | undefined,
  env: AgentEnvDefaults,
): ResolvedAgentSettings {
  const runnerRaw = (nonEmpty(row?.agentRunner) ?? nonEmpty(env.runner) ?? 'cursor').toLowerCase();
  const runner: AgentRunner = runnerRaw === 'claude' ? 'claude' : 'cursor';
  const claudeModel = nonEmpty(row?.claudeAgentModel) ?? nonEmpty(env.claudeModel) ?? 'openai/glm-5.2';
  const cursorModel = nonEmpty(env.cursorModel) ?? 'claude-sonnet-4-5';
  return {
    runner,
    model: runner === 'claude' ? claudeModel : cursorModel,
    claudeModel,
    anthropicBaseUrl: optionalOverride(row?.anthropicBaseUrl, env.baseUrl),
    anthropicApiKey: optionalOverride(row?.anthropicApiKey, env.apiKey),
  };
}

/** Label used in worker and CLI logs. */
export function agentRunLogLine(settings: Pick<ResolvedAgentSettings, 'runner' | 'model' | 'anthropicBaseUrl'>): string {
  const url = settings.anthropicBaseUrl ?? '(not set)';
  return `runner=${settings.runner} model=${settings.model} url=${url}`;
}

/** Extra fields the API adds so the UI can show effective settings without echoing secrets. */
export interface WorkerConfigAgentMeta {
  anthropicApiKeyConfigured: boolean;
  anthropicApiKeyFromEnv: boolean;
  claudeAgentModelFromEnv: boolean;
  agentRunnerFromEnv: boolean;
  anthropicBaseUrlFromEnv: boolean;
}

export type WorkerConfigRow = AgentSettingsRow & Record<string, unknown>;

/**
 * Merge DB worker config with process env for API/UI responses.
 * Secrets from .env are not returned — only whether they are configured.
 */
export function buildWorkerConfigForClient(
  row: WorkerConfigRow,
  env: AgentEnvDefaults,
): WorkerConfigRow & WorkerConfigAgentMeta & {
  agentRunner: AgentRunner;
  claudeAgentModel: string;
  anthropicBaseUrl: string;
  anthropicApiKey: string;
} {
  const resolved = resolveAgentSettings(row, env);
  const dbRunner = nonEmpty(row.agentRunner);
  const dbClaudeModel = nonEmpty(row.claudeAgentModel);
  const dbBaseUrl = row.anthropicBaseUrl != null ? nonEmpty(row.anthropicBaseUrl) : undefined;
  const dbApiKey = row.anthropicApiKey != null ? nonEmpty(row.anthropicApiKey) : undefined;

  return {
    ...row,
    agentRunner: resolved.runner,
    claudeAgentModel: resolved.claudeModel,
    anthropicBaseUrl: resolved.anthropicBaseUrl ?? '',
    // Never echo .env secrets — only values stored in the DB (for editing).
    anthropicApiKey: dbApiKey ?? '',
    anthropicApiKeyConfigured: !!resolved.anthropicApiKey,
    anthropicApiKeyFromEnv: !dbApiKey && !!nonEmpty(env.apiKey),
    claudeAgentModelFromEnv: !dbClaudeModel && !!nonEmpty(env.claudeModel),
    agentRunnerFromEnv: !dbRunner && !!nonEmpty(env.runner),
    anthropicBaseUrlFromEnv: row.anthropicBaseUrl == null && !!nonEmpty(env.baseUrl),
  };
}
