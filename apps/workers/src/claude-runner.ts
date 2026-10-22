/**
 * claude-runner.ts — single integration point for @anthropic-ai/claude-agent-sdk.
 *
 * Production code imports the Agent SDK only from this file (Claude Code runtime:
 * tools, skills under .cursor/skills, multi-turn). When ANTHROPIC_BASE_URL or
 * ANTHROPIC_API_KEY are empty, those options are not sent to the subprocess.
 */

import path from 'path';
import { existsSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { RunSkillOptions, RunSkillResult } from './cursor-runner.js';

export interface ClaudeSkillOptions extends RunSkillOptions {
  /** Proxy base URL (Anthropic-compatible, e.g. https://openrouter.ai/api). */
  anthropicBaseUrl?: string;
  /** API key for the proxy or Anthropic. */
  anthropicApiKey?: string;
}

/** @deprecated Agent SDK uses turns; kept for claude-agent-test-cli compatibility. */
export function claudeMaxTokens(): number {
  const raw = process.env.CLAUDE_MAX_TOKENS?.trim();
  const n = raw ? Number(raw) : 16384;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 16384;
}

export function claudeAgentMaxTurns(): number {
  const raw = process.env.CLAUDE_AGENT_MAX_TURNS?.trim();
  if (!raw) return 50;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
}

/**
 * Environment for the Claude Code subprocess spawned by the Agent SDK.
 * Does not mutate process.env — pass via `options.env` on query().
 */
/** True when Node runs as uid 0 (typical Docker workers container). */
export function isClaudeAgentPrivilegedRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * bypassPermissions maps to --dangerously-skip-permissions, which Claude Code
 * refuses under root/sudo. Headless workers on Docker use acceptEdits + canUseTool.
 */
export function claudeAgentPermissionMode(): PermissionMode {
  const override = process.env.CLAUDE_AGENT_PERMISSION_MODE?.trim() as PermissionMode | '';
  const allowed: PermissionMode[] = [
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'dontAsk',
    'auto',
  ];
  if (override && allowed.includes(override)) return override;
  return isClaudeAgentPrivilegedRoot() ? 'acceptEdits' : 'bypassPermissions';
}

export function buildClaudeAgentSubprocessEnv(
  baseUrl?: string,
  apiKey?: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const url = baseUrl?.trim();
  const key = apiKey?.trim();
  if (url) env.ANTHROPIC_BASE_URL = url;
  if (key) env.ANTHROPIC_API_KEY = key;
  return env;
}

type AssistantBlock = { type?: string; text?: string };
type StreamMessage = {
  type?: string;
  message?: { content?: AssistantBlock[] };
  subtype?: string;
  result?: string;
  errors?: string[];
};

function appendAssistantText(message: StreamMessage, onChunk?: (chunk: string) => void): string {
  let chunk = '';
  for (const block of message.message?.content ?? []) {
    if (block.type === 'text' && block.text) chunk += block.text;
  }
  if (chunk) {
    if (onChunk) onChunk(chunk);
  }
  return chunk;
}

export async function runClaudeSkill(options: ClaudeSkillOptions): Promise<RunSkillResult> {
  const { skillPath, promptSuffix, cwd, model, onChunk } = options;
  const debug = options.debug ?? process.env.DEBUG_CURSOR === 'true';
  const baseUrl = options.anthropicBaseUrl?.trim() || undefined;
  const apiKey = options.anthropicApiKey?.trim() || undefined;
  const prompt = promptSuffix ? `${skillPath}\n${promptSuffix}` : skillPath;
  const maxTurns = claudeAgentMaxTurns();

  const cwdInfo =
    `[claude-runner] agent-sdk cwd = ${cwd} ` +
    `(absolute=${path.isAbsolute(cwd)}, exists=${existsSync(cwd)}, ` +
    `processCwd=${process.cwd()})`;
  process.stderr.write(`${cwdInfo}\n`);
  if (options.onDebug) options.onDebug(cwdInfo);

  const permissionMode = claudeAgentPermissionMode();
  const bypassPermissions =
    permissionMode === 'bypassPermissions' && !isClaudeAgentPrivilegedRoot();

  if (debug) {
    process.stderr.write(`[claude-runner] model      : ${model}\n`);
    process.stderr.write(`[claude-runner] url        : ${baseUrl ?? '(not set)'}\n`);
    process.stderr.write(`[claude-runner] api-key    : ${apiKey ? 'set' : '(not set)'}\n`);
    process.stderr.write(`[claude-runner] max-turns  : ${maxTurns}\n`);
    process.stderr.write(
      `[claude-runner] permissions: mode=${permissionMode} root=${isClaudeAgentPrivilegedRoot()} bypass=${bypassPermissions}\n`,
    );
  }

  const canUseTool: CanUseTool | undefined =
    permissionMode !== 'bypassPermissions'
      ? async (toolName) => {
          if (debug) {
            process.stderr.write(`[claude-runner] allow tool: ${toolName}\n`);
          }
          return { behavior: 'allow' };
        }
      : undefined;

  if (options.onDebug) {
    options.onDebug(`agent.query prompt (${prompt.length} chars):\n${prompt}`);
  }

  let outputText = '';
  let resultError: string | undefined;
  let messageCount = 0;

  try {
    const q = query({
      prompt,
      options: {
        model,
        cwd,
        maxTurns,
        permissionMode,
        ...(bypassPermissions ? { allowDangerouslySkipPermissions: true as const } : {}),
        ...(canUseTool ? { canUseTool } : {}),
        tools: { type: 'preset', preset: 'claude_code' },
        settingSources: ['project'],
        persistSession: false,
        env: buildClaudeAgentSubprocessEnv(baseUrl, apiKey),
      },
    });

    for await (const raw of q) {
      messageCount++;
      const message = raw as StreamMessage;
      const t = message.type;

      if (t === 'assistant') {
        appendAssistantText(message, (delta) => {
          outputText += delta;
          if (debug) process.stderr.write(delta);
        });
      }

      if (t === 'result') {
        if (message.subtype === 'error' || message.subtype === 'error_during_execution') {
          resultError = message.errors?.join('; ') ?? message.result ?? message.subtype;
        } else if (typeof message.result === 'string' && message.result && !outputText) {
          outputText = message.result;
        }
      }
    }

    const done =
      `[claude-runner] finished model=${model} chars=${outputText.length} messages=${messageCount}`;
    process.stderr.write(`${done}\n`);
    if (options.onDebug) options.onDebug(done);

    if (resultError) {
      throw new Error(`Claude agent run failed: ${resultError}`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[claude-runner] ERROR: ${errMsg}\n`);
    if (options.onDebug) options.onDebug(`[claude-runner] ERROR: ${errMsg}`);
    const rootHint = /root\/sudo|dangerously-skip-permissions/i.test(errMsg)
      ? ' — rebuild workers with the latest claude-runner (root uses acceptEdits + canUseTool, not bypassPermissions)'
      : '';
    const authHint = /auth|unauth|401|api.key|token/i.test(errMsg)
      ? ' — check ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY in Settings → Scanner'
      : '';
    if (err instanceof Error && rootHint && !err.message.includes('acceptEdits')) {
      throw new Error(`${err.message}${rootHint}`);
    }
    if (err instanceof Error && authHint && !err.message.includes('ANTHROPIC_')) {
      throw new Error(`${err.message}${authHint}`);
    }
    throw err;
  }

  if (debug && outputText) {
    process.stderr.write(`[claude-runner] ── RESPONSE TEXT (${outputText.length} chars) ──\n`);
    process.stderr.write(outputText);
    process.stderr.write('\n[claude-runner] ────────────────────────────────────────────────────\n');
  }

  return { text: outputText };
}
