/**
 * Connection tests used by worker CLIs and the API Settings → Scanner test button.
 */

import { mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { Agent } from '@cursor/sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildModelSelection } from './cursor-runner.js';
import {
  buildClaudeAgentSubprocessEnv,
  claudeAgentPermissionMode,
  isClaudeAgentPrivilegedRoot,
} from './claude-runner.js';

export type AgentConnectionTestResult = {
  ok: boolean;
  runner: 'cursor' | 'claude';
  model: string;
  message: string;
  latencyMs: number;
  detail?: string;
  log?: string;
};

const CURSOR_PROMPT = 'Reply with exactly one line: MODEL_TEST_OK (no other text).';
const CLAUDE_PROMPT = 'Reply with exactly one line: AGENT_SDK_TEST_OK (no markdown, no tools).';

export async function testCursorAgentConnection(input: {
  apiKey: string;
  model: string;
  cwd?: string;
}): Promise<AgentConnectionTestResult> {
  const t0 = Date.now();
  const modelId = input.model.trim();
  const apiKey = input.apiKey.trim();
  const cwd = path.resolve(input.cwd ?? os.tmpdir());

  if (!apiKey) {
    return {
      ok: false,
      runner: 'cursor',
      model: modelId,
      message: 'CURSOR_API_KEY is not configured',
      latencyMs: Date.now() - t0,
    };
  }
  try {
    mkdirSync(cwd, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      runner: 'cursor',
      model: modelId,
      message: `Cannot create workspace directory: ${cwd}`,
      detail: msg,
      latencyMs: Date.now() - t0,
    };
  }

  const model = buildModelSelection(modelId);
  const agent = await Agent.create({ apiKey, model, local: { cwd } });
  let outputText = '';

  try {
    const run = await agent.send(CURSOR_PROMPT);
    if (run.supports('stream')) {
      for await (const event of run.stream()) {
        const e = event as {
          type?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        if (e.type === 'assistant' && e.message?.content) {
          for (const block of e.message.content) {
            if (block.type === 'text' && block.text) outputText += block.text;
          }
        }
      }
    }
    const result = await run.wait();
    if (!outputText && result.result) outputText = result.result;

    if (result.status === 'error') {
      return {
        ok: false,
        runner: 'cursor',
        model: modelId,
        message: 'Cursor agent run failed',
        detail: result.id,
        latencyMs: Date.now() - t0,
      };
    }
    if (!/MODEL_TEST_OK/.test(outputText)) {
      return {
        ok: false,
        runner: 'cursor',
        model: modelId,
        message: 'Unexpected model response',
        detail: outputText.slice(0, 400),
        latencyMs: Date.now() - t0,
      };
    }
    return {
      ok: true,
      runner: 'cursor',
      model: modelId,
      message: 'Cursor API key and model responded correctly',
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      runner: 'cursor',
      model: modelId,
      message: msg,
      detail: msg,
      latencyMs: Date.now() - t0,
    };
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

export async function testClaudeAgentSdkConnection(input: {
  model: string;
  baseUrl: string;
  apiKey: string;
  cwd?: string;
}): Promise<AgentConnectionTestResult> {
  const t0 = Date.now();
  const model = input.model.trim();
  const baseUrl = input.baseUrl.trim();
  const apiKey = input.apiKey.trim();
  const cwd = path.resolve(input.cwd ?? os.tmpdir());

  if (!baseUrl) {
    return {
      ok: false,
      runner: 'claude',
      model,
      message: 'ANTHROPIC_BASE_URL is not configured',
      latencyMs: Date.now() - t0,
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      runner: 'claude',
      model,
      message: 'ANTHROPIC_API_KEY is not configured',
      latencyMs: Date.now() - t0,
    };
  }

  try {
    mkdirSync(cwd, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      runner: 'claude',
      model,
      message: `Cannot create workspace directory: ${cwd}`,
      detail: msg,
      latencyMs: Date.now() - t0,
    };
  }

  const permissionMode = claudeAgentPermissionMode();
  const bypass = permissionMode === 'bypassPermissions' && !isClaudeAgentPrivilegedRoot();
  let assistantText = '';
  let resultError: string | undefined;

  try {
    const q = query({
      prompt: CLAUDE_PROMPT,
      options: {
        model,
        cwd,
        maxTurns: 5,
        permissionMode,
        ...(bypass ? { allowDangerouslySkipPermissions: true as const } : { canUseTool: async () => ({ behavior: 'allow' as const }) }),
        tools: [],
        persistSession: false,
        env: buildClaudeAgentSubprocessEnv(baseUrl, apiKey),
      },
    });

    for await (const message of q) {
      const t = (message as { type?: string }).type;
      if (t === 'assistant') {
        const content = (message as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content;
        for (const block of content ?? []) {
          if (block.type === 'text' && block.text) assistantText += block.text;
        }
      }
      if (t === 'result') {
        const r = message as { subtype?: string; result?: string; errors?: string[] };
        if (r.subtype === 'error' || r.subtype === 'error_during_execution') {
          resultError = r.errors?.join('; ') ?? r.result ?? r.subtype;
        } else if (typeof r.result === 'string' && r.result) {
          assistantText = assistantText || r.result;
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      runner: 'claude',
      model,
      message: msg,
      detail: msg,
      latencyMs: Date.now() - t0,
    };
  }

  if (resultError) {
    return {
      ok: false,
      runner: 'claude',
      model,
      message: resultError,
      latencyMs: Date.now() - t0,
    };
  }
  if (!/AGENT_SDK_TEST_OK/.test(assistantText)) {
    return {
      ok: false,
      runner: 'claude',
      model,
      message: 'Claude Agent SDK responded but test marker was missing',
      detail: assistantText.slice(0, 400),
      latencyMs: Date.now() - t0,
    };
  }

  return {
    ok: true,
    runner: 'claude',
    model,
    message: 'Claude Agent SDK, base URL, and model responded correctly',
    latencyMs: Date.now() - t0,
    log: `root=${isClaudeAgentPrivilegedRoot()} permissionMode=${permissionMode}`,
  };
}
