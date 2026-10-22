/**
 * Resolve agent runner, models, and API credentials for workers.
 *
 * Database null → inherit environment. Empty string on string fields → inherit env
 * (legacy). For anthropic URL/key, empty string in DB means explicitly unset.
 */

export type AgentRunner = 'cursor' | 'claude';

export interface AgentSettingsRow {
  agentRunner?: string | null;
  claudeAgentModel?: string | null;
  anthropicBaseUrl?: string | null;
  anthropicApiKey?: string | null;
  cursorAgentModel?: string | null;
  cursorApiKey?: string | null;
  cursorAgentTimeoutMs?: number | null;
  debugAgent?: boolean | null;
  claudeMaxTokens?: number | null;
  claudeAgentMaxTurns?: number | null;
}

export interface AgentEnvDefaults {
  runner?: string | null;
  claudeModel?: string | null;
  cursorModel: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  cursorApiKey?: string | null;
  cursorAgentTimeoutMs?: number | null;
  debugAgent?: boolean | null;
  claudeMaxTokens?: number | null;
  claudeAgentMaxTurns?: number | null;
}

export interface ResolvedAgentSettings {
  runner: AgentRunner;
  model: string;
  claudeModel: string;
  cursorModel: string;
  anthropicBaseUrl?: string;
  anthropicApiKey?: string;
}

export interface ResolvedAgentRuntime extends ResolvedAgentSettings {
  cursorApiKey?: string;
  cursorAgentTimeoutMs: number;
  debugAgent: boolean;
  claudeMaxTokens: number;
  claudeAgentMaxTurns: number;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionalOverride(
  dbValue: string | null | undefined,
  envValue: string | null | undefined,
): string | undefined {
  if (dbValue == null) return nonEmpty(envValue);
  const fromDb = nonEmpty(dbValue);
  if (fromDb !== undefined) return fromDb;
  return nonEmpty(envValue);
}

function optionalIntOverride(
  dbValue: number | null | undefined,
  envValue: number | null | undefined,
  fallback: number,
): number {
  if (dbValue != null && Number.isFinite(dbValue)) return Math.floor(dbValue);
  if (envValue != null && Number.isFinite(envValue)) return Math.floor(envValue);
  return fallback;
}

function optionalBoolOverride(
  dbValue: boolean | null | undefined,
  envValue: boolean | null | undefined,
  fallback: boolean,
): boolean {
  if (dbValue != null) return dbValue;
  if (envValue != null) return envValue;
  return fallback;
}

export function resolveAgentSettings(
  row: AgentSettingsRow | null | undefined,
  env: AgentEnvDefaults,
): ResolvedAgentSettings {
  const runnerRaw = (nonEmpty(row?.agentRunner) ?? nonEmpty(env.runner) ?? 'cursor').toLowerCase();
  const runner: AgentRunner = runnerRaw === 'claude' ? 'claude' : 'cursor';
  const claudeModel = nonEmpty(row?.claudeAgentModel) ?? nonEmpty(env.claudeModel) ?? 'openai/glm-5.2';
  const cursorModel = nonEmpty(row?.cursorAgentModel) ?? nonEmpty(env.cursorModel) ?? 'composer-2.5';
  return {
    runner,
    model: runner === 'claude' ? claudeModel : cursorModel,
    claudeModel,
    cursorModel,
    anthropicBaseUrl: optionalOverride(row?.anthropicBaseUrl, env.baseUrl),
    anthropicApiKey: optionalOverride(row?.anthropicApiKey, env.apiKey),
  };
}

export function resolveAgentRuntime(
  row: AgentSettingsRow | null | undefined,
  env: AgentEnvDefaults,
): ResolvedAgentRuntime {
  const base = resolveAgentSettings(row, env);
  return {
    ...base,
    cursorApiKey: optionalOverride(row?.cursorApiKey, env.cursorApiKey),
    cursorAgentTimeoutMs: optionalIntOverride(row?.cursorAgentTimeoutMs, env.cursorAgentTimeoutMs, 300_000),
    debugAgent: optionalBoolOverride(row?.debugAgent, env.debugAgent, false),
    claudeMaxTokens: optionalIntOverride(row?.claudeMaxTokens, env.claudeMaxTokens, 16_384),
    claudeAgentMaxTurns: optionalIntOverride(row?.claudeAgentMaxTurns, env.claudeAgentMaxTurns, 50),
  };
}

export function agentRunLogLine(settings: Pick<ResolvedAgentSettings, 'runner' | 'model' | 'anthropicBaseUrl'>): string {
  const url = settings.anthropicBaseUrl ?? '(not set)';
  return `runner=${settings.runner} model=${settings.model} url=${url}`;
}

export interface WorkerConfigAgentMeta {
  anthropicApiKeyConfigured: boolean;
  anthropicApiKeyFromEnv: boolean;
  claudeAgentModelFromEnv: boolean;
  agentRunnerFromEnv: boolean;
  anthropicBaseUrlFromEnv: boolean;
  cursorAgentModelFromEnv: boolean;
  cursorApiKeyConfigured: boolean;
  cursorApiKeyFromEnv: boolean;
  cursorAgentTimeoutMsFromEnv: boolean;
  debugAgentFromEnv: boolean;
  claudeMaxTokensFromEnv: boolean;
  claudeAgentMaxTurnsFromEnv: boolean;
}

export type WorkerConfigRow = AgentSettingsRow & Record<string, unknown>;

export function buildWorkerConfigForClient(
  row: WorkerConfigRow,
  env: AgentEnvDefaults,
): WorkerConfigRow &
  WorkerConfigAgentMeta & {
    agentRunner: AgentRunner;
    claudeAgentModel: string;
    cursorAgentModel: string;
    anthropicBaseUrl: string;
    anthropicApiKey: string;
    cursorApiKey: string;
    cursorAgentTimeoutMs: number;
    debugAgent: boolean;
    claudeMaxTokens: number;
    claudeAgentMaxTurns: number;
  } {
  const runtime = resolveAgentRuntime(row, env);
  const dbRunner = nonEmpty(row.agentRunner);
  const dbClaudeModel = nonEmpty(row.claudeAgentModel);
  const dbCursorModel = nonEmpty(row.cursorAgentModel);
  const dbBaseUrl = row.anthropicBaseUrl != null ? nonEmpty(row.anthropicBaseUrl) : undefined;
  const dbApiKey = row.anthropicApiKey != null ? nonEmpty(row.anthropicApiKey) : undefined;
  const dbCursorKey = row.cursorApiKey != null ? nonEmpty(row.cursorApiKey) : undefined;

  return {
    ...row,
    agentRunner: runtime.runner,
    claudeAgentModel: runtime.claudeModel,
    cursorAgentModel: runtime.cursorModel,
    anthropicBaseUrl: runtime.anthropicBaseUrl ?? '',
    anthropicApiKey: dbApiKey ?? '',
    cursorApiKey: dbCursorKey ?? '',
    cursorAgentTimeoutMs: runtime.cursorAgentTimeoutMs,
    debugAgent: runtime.debugAgent,
    claudeMaxTokens: runtime.claudeMaxTokens,
    claudeAgentMaxTurns: runtime.claudeAgentMaxTurns,
    anthropicApiKeyConfigured: !!runtime.anthropicApiKey,
    anthropicApiKeyFromEnv: !dbApiKey && !!nonEmpty(env.apiKey),
    claudeAgentModelFromEnv: !dbClaudeModel && !!nonEmpty(env.claudeModel),
    agentRunnerFromEnv: !dbRunner && !!nonEmpty(env.runner),
    anthropicBaseUrlFromEnv: row.anthropicBaseUrl == null && !!nonEmpty(env.baseUrl),
    cursorAgentModelFromEnv: !dbCursorModel && !!nonEmpty(env.cursorModel),
    cursorApiKeyConfigured: !!runtime.cursorApiKey,
    cursorApiKeyFromEnv: !dbCursorKey && !!nonEmpty(env.cursorApiKey),
    cursorAgentTimeoutMsFromEnv: row.cursorAgentTimeoutMs == null && env.cursorAgentTimeoutMs != null,
    debugAgentFromEnv: row.debugAgent == null && env.debugAgent != null,
    claudeMaxTokensFromEnv: row.claudeMaxTokens == null && env.claudeMaxTokens != null,
    claudeAgentMaxTurnsFromEnv: row.claudeAgentMaxTurns == null && env.claudeAgentMaxTurns != null,
  };
}
