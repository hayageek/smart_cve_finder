/**
 * agent-runner.ts — dispatches a skill run to the Cursor or Claude runner.
 *
 * Pipeline code calls runAgentSkill. The concrete SDK imports stay inside
 * cursor-runner.ts and claude-runner.ts.
 */

import type { RunSkillOptions, RunSkillResult } from './cursor-runner.js';
import { runCursorSkill } from './cursor-runner.js';
import { runClaudeSkill } from './claude-runner.js';

export interface AgentSkillOptions extends RunSkillOptions {
  /** Defaults to cursor when omitted. */
  runner?: 'cursor' | 'claude';
  /** Passed to the Claude runner only. Omitted from the subprocess when empty. */
  anthropicBaseUrl?: string;
  /** Passed to the Claude runner only. Omitted from the request when empty. */
  anthropicApiKey?: string;
}

export async function runAgentSkill(options: AgentSkillOptions): Promise<RunSkillResult> {
  const runner = options.runner === 'claude' ? 'claude' : 'cursor';
  const url = options.anthropicBaseUrl?.trim() || '(not set)';
  const summary = `runner=${runner} model=${options.model} url=${url}`;
  process.stderr.write(`[agent] ${summary}\n`);
  if (options.onDebug) options.onDebug(summary);

  if (runner === 'claude') {
    return runClaudeSkill(options);
  }
  return runCursorSkill(options);
}
