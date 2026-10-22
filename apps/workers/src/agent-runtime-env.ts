import { resolveAgentRuntime, type AgentEnvDefaults, type AgentSettingsRow, type ResolvedAgentRuntime } from '@secscan/shared';
import { config } from './config.js';

export function workerAgentEnvDefaults(): AgentEnvDefaults {
  return {
    runner: config.AGENT_RUNNER,
    claudeModel: config.CLAUDE_AGENT_MODEL,
    cursorModel: config.CURSOR_AGENT_MODEL,
    baseUrl: config.ANTHROPIC_BASE_URL,
    apiKey: config.ANTHROPIC_API_KEY,
    cursorApiKey: config.CURSOR_API_KEY,
    cursorAgentTimeoutMs: config.CURSOR_AGENT_TIMEOUT_MS,
    debugAgent: config.DEBUG_AGENT,
    claudeMaxTokens: config.CLAUDE_MAX_TOKENS,
    claudeAgentMaxTurns: config.CLAUDE_AGENT_MAX_TURNS,
  };
}

export function resolveWorkerAgentRuntime(row: AgentSettingsRow | null | undefined): ResolvedAgentRuntime {
  return resolveAgentRuntime(row, workerAgentEnvDefaults());
}
