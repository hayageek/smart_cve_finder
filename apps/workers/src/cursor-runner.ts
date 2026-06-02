/**
 * cursor-runner.ts — single integration point for @cursor/sdk.
 *
 * ALL @cursor/sdk imports live here. Nothing else in the codebase should
 * import from @cursor/sdk directly.
 *
 * Public API
 * ──────────
 *   runCursorSkill(options)
 *     Runs a Cursor skill in a local workspace directory.
 *     Supports optional live streaming via the `onChunk` callback:
 *       - Workers omit `onChunk` and receive the final accumulated text.
 *       - The CLI passes `onChunk: (chunk) => process.stdout.write(chunk)`
 *         to print output in real time.
 *
 * Error handling
 * ──────────────
 *   CursorAgentError  → startup failure (auth, network, config). Re-thrown as
 *                        a plain Error with a human-readable hint.
 *   result.status === 'error' → the agent ran but the run itself failed.
 */

import { setMaxListeners } from 'events';
import path from 'path';
import { existsSync } from 'fs';
import { Agent, CursorAgentError, type ModelSelection } from '@cursor/sdk';

// @cursor/sdk attaches AbortSignal listeners for every concurrent run.
// With multiple parallel workers the default limit of 10 is exceeded quickly.
// Setting a generous limit here (this module is the single SDK entry point).
setMaxListeners(100);

// ── Public types ──────────────────────────────────────────────────

export interface RunSkillOptions {
  /** Skill path, e.g. "/cve-pattern-hunter" */
  skillPath: string;
  /**
   * Extra text appended after the skill path.
   * Used by exploit-generator to pass the vulnerability JSON.
   */
  promptSuffix?: string;
  /** Absolute path to the workspace directory (must contain .cursor/skills/). */
  cwd: string;
  /** Cursor model ID, e.g. "claude-sonnet-4-5" or "composer-2.5". */
  model: string;
  /**
   * Composer 2.5 fast tier. false = standard (cheaper billing).
   * Defaults to CURSOR_AGENT_MODEL_FAST env (false when unset).
   */
  modelFast?: boolean;
  /**
   * Cursor API key. Falls back to CURSOR_API_KEY env var when omitted.
   * Get yours at https://cursor.com/settings
   */
  apiKey?: string;
  /**
   * Optional streaming callback — called with each text chunk as the agent
   * produces output. Useful for CLI live output.
   * When omitted the function runs silently and returns the full text.
   */
  onChunk?: (chunk: string) => void;
  /**
   * Enable debug logging of the full prompt and response text to stderr.
   * Controlled by DEBUG_CURSOR=true in .env.
   */
  debug?: boolean;
  /** When debug is on, single-line status messages are also sent here (e.g. worker logger). */
  onDebug?: (message: string) => void;
}

export interface RunSkillResult {
  /** Full accumulated text output from the agent. */
  text: string;
}

// ── Implementation ────────────────────────────────────────────────

// ── Debug logger (stderr so it never pollutes captured stdout) ────

function createDbg(onDebug?: (message: string) => void) {
  const notify = (line: string) => {
    if (line && onDebug) onDebug(line);
  };
  return {
    line: (label: string) => {
      process.stderr.write(`\n[cursor-runner] ${'─'.repeat(60)}\n[cursor-runner] ${label}\n`);
      notify(`[cursor-runner] ${label}`);
    },
    kv: (key: string, value: string) => {
      const msg = `[cursor-runner] ${key}: ${value}`;
      process.stderr.write(`[cursor-runner] ${key.padEnd(12)}: ${value}\n`);
      notify(msg);
    },
    block: (label: string, text: string) => {
      process.stderr.write(`[cursor-runner] ── ${label} (${text.length} chars) ──\n`);
      process.stderr.write(text);
      process.stderr.write('\n[cursor-runner] ────────────────────────────────────────────────────\n');
      notify(`[cursor-runner] ${label}: ${text.length} chars`);
    },
  };
}

// ── Model selection ─────────────────────────────────────────────────

/** True when env/options request Composer fast tier (standard = false). */
export function resolveModelFast(explicit?: boolean): boolean {
  return explicit ?? process.env.CURSOR_AGENT_MODEL_FAST === 'true';
}

/**
 * Build SDK model selection. Composer models get an explicit `fast` param so
 * we do not rely on the API default variant (fast=true → cursor-2.5-fast billing).
 */
export function buildModelSelection(modelId: string, modelFast?: boolean): ModelSelection {
  if (!modelId.toLowerCase().includes('composer')) {
    return { id: modelId };
  }
  const fast = resolveModelFast(modelFast);
  return {
    id: modelId,
    params: [{ id: 'fast', value: fast ? 'true' : 'false' }],
  };
}

// ── Implementation ────────────────────────────────────────────────

export async function runCursorSkill(options: RunSkillOptions): Promise<RunSkillResult> {
  const { skillPath, promptSuffix, cwd, model, onChunk } = options;
  const modelSelection = buildModelSelection(model, options.modelFast);
  const debug = options.debug ?? process.env.DEBUG_CURSOR === 'true';
  const DBG = createDbg(options.onDebug);

  // Resolve API key: explicit option > CURSOR_API_KEY env var
  const apiKey = options.apiKey ?? process.env.CURSOR_API_KEY;
  if (!apiKey) {
    throw new Error(
      'CURSOR_API_KEY is required.\n' +
      'Set it in your .env file or pass it via the apiKey option.\n' +
      'Get your key at https://cursor.com/settings',
    );
  }

  const prompt = promptSuffix ? `${skillPath}\n${promptSuffix}` : skillPath;

  // ── Debug: additionally log to stderr ─────────────────────────────
  if (debug) {
    DBG.line('REQUEST');
    DBG.kv('skill',  skillPath);
    DBG.kv('model',  model);
    DBG.kv('model-params', JSON.stringify(modelSelection.params ?? []));
    DBG.kv('cwd',    cwd);
    DBG.kv('api-key', `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`);
    if (promptSuffix) DBG.block('PROMPT SUFFIX', promptSuffix);
    else              DBG.kv('prompt',  prompt);
  }

  // ── Final cwd sanity log ─────────────────────────────────────────
  // This is the LAST hop before the Cursor SDK takes over. Print to stderr
  // unconditionally so an operator can see — for every single agent run —
  // exactly what working directory the agent will use. This makes it trivial
  // to spot a misconfigured path that causes the agent to scan the wrong tree.
  const cwdInfo =
    `[cursor-runner] Agent.create local.cwd = ${cwd} ` +
    `(absolute=${path.isAbsolute(cwd)}, exists=${existsSync(cwd)}, ` +
    `processCwd=${process.cwd()})`;
  process.stderr.write(`${cwdInfo}\n`);
  if (options.onDebug) options.onDebug(cwdInfo);

  if (!path.isAbsolute(cwd)) {
    process.stderr.write(
      `[cursor-runner] WARNING: local.cwd is RELATIVE — the agent process will ` +
      `resolve it against its own working dir and may scan an unintended tree.\n`,
    );
  }
  if (!existsSync(cwd)) {
    process.stderr.write(
      `[cursor-runner] WARNING: local.cwd does NOT exist on disk (${cwd}).\n`,
    );
  }

  // Use Agent.create() + agent.send() so we can optionally stream.
  // Agent.prompt() is simpler but doesn't expose run.stream().
  const agent = await Agent.create({ apiKey, model: modelSelection, local: { cwd } });

  let outputText = '';

  try {
    // Log the exact prompt sent to the agent → pino file + stdout + Redis live stream.
    if (options.onDebug) {
      options.onDebug(
        `model=${model} fast=${modelSelection.params?.find((p) => p.id === 'fast')?.value ?? 'n/a'} cwd=${cwd}`,
      );
      options.onDebug(`agent.send prompt (${prompt.length} chars):\n${prompt}`);
    }

    const run = await agent.send(prompt);

    if (debug) {
      DBG.line('RESPONSE — streaming');
    }

    // Stream chunks to the caller if they want live output.
    if (onChunk && run.supports('stream')) {
      for await (const event of run.stream()) {
        const e = event as {
          type?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        if (e.type === 'assistant' && e.message?.content) {
          for (const block of e.message.content) {
            if (block.type === 'text' && block.text) {
              onChunk(block.text);
              outputText += block.text;
              if (debug) process.stderr.write(block.text);
            }
          }
        }
      }
      if (debug) process.stderr.write('\n');
    }

    const result = await run.wait();
    if (result.status === 'error') {
      throw new Error(`Cursor agent run failed (run id: ${result.id})`);
    }

    // Prefer streamed text (already accumulated above).
    // Fall back to result.result when streaming was skipped or empty.
    if (!outputText && result.result) {
      outputText = result.result;
    }

    // ── Debug: log the final response ───────────────────────────────
    if (debug) {
      if (!onChunk) {
        // Streamed output was already printed above; only print here for non-streaming callers.
        DBG.block('RESPONSE TEXT', outputText);
      }
      DBG.line('DONE');
      DBG.kv('status',   result.status);
      DBG.kv('run-id',   result.id ?? '(none)');
      DBG.kv('chars',    String(outputText.length));
    }

  } catch (err) {
    if (debug) {
      DBG.line('ERROR');
      process.stderr.write(`[cursor-runner] ${String(err)}\n`);
    }
    if (err instanceof CursorAgentError) {
      const retryHint = err.isRetryable ? ' (retryable)' : '';
      const authHint  = err.message?.toLowerCase().includes('unauth')
        ? ' — verify CURSOR_API_KEY at https://cursor.com/settings'
        : '';
      throw new Error(`Cursor agent startup failed: ${err.message}${retryHint}${authHint}`);
    }
    throw err;
  } finally {
    await agent[Symbol.asyncDispose]();
  }

  return { text: outputText };
}
