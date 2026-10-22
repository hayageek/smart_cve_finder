#!/usr/bin/env node
/**
 * Smoke-test @anthropic-ai/claude-agent-sdk with repo .env (OpenRouter / Anthropic gateway).
 *
 *   npm run claude-agent-sdk-test -w apps/workers
 *   npm run claude-agent-sdk-test -w apps/workers -- --auth openrouter
 *
 * --auth env (default): ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY from .env
 * --auth openrouter:    ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY=""
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  buildClaudeAgentSubprocessEnv,
  claudeAgentPermissionMode,
  isClaudeAgentPrivilegedRoot,
} from './claude-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
dotenv.config({ path: path.join(repoRoot, '.env') });

const argv = process.argv.slice(2);
function getFlag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

const authMode = getFlag('--auth') ?? 'env';
const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
const model = process.env.CLAUDE_AGENT_MODEL?.trim() ?? 'claude-sonnet-4-5';

function buildAgentEnv(): Record<string, string | undefined> {
  const env = buildClaudeAgentSubprocessEnv(baseUrl, apiKey);
  if (authMode === 'openrouter' && apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
    env.ANTHROPIC_API_KEY = '';
  }
  return env;
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!baseUrl) die('ANTHROPIC_BASE_URL is not set in .env');
  if (!apiKey) die('ANTHROPIC_API_KEY is not set in .env');

  console.log('\n── Claude Agent SDK smoke test ──');
  console.log(`  auth mode   : ${authMode}`);
  console.log(`  base URL    : ${baseUrl}`);
  console.log(`  model       : ${model}`);
  console.log(`  API key     : set (${apiKey.slice(0, 8)}…)`);
  console.log(`  root uid 0  : ${isClaudeAgentPrivilegedRoot()}`);
  console.log(`  perm mode   : ${claudeAgentPermissionMode()}`);
  console.log('────────────────────────────────\n');

  const prompt =
    'Reply with exactly one line: AGENT_SDK_TEST_OK (no markdown, no tools).';

  const agentEnv = buildAgentEnv();
  let assistantText = '';
  let resultError: string | undefined;
  let messageCount = 0;

  const t0 = Date.now();
  try {
    const q = query({
      prompt,
      options: {
        model,
        cwd: repoRoot,
        maxTurns: 5,
        permissionMode: claudeAgentPermissionMode(),
        ...(claudeAgentPermissionMode() === 'bypassPermissions'
          ? { allowDangerouslySkipPermissions: true as const }
          : {
              canUseTool: async () => ({ behavior: 'allow' as const }),
            }),
        tools: [],
        persistSession: false,
        env: agentEnv,
      },
    });

    for await (const message of q) {
      messageCount++;
      const t = (message as { type?: string }).type;
      if (t === 'assistant') {
        const content = (message as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content;
        for (const block of content ?? []) {
          if (block.type === 'text' && block.text) {
            assistantText += block.text;
            process.stdout.write(block.text);
          }
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
      if (messageCount <= 8) {
        console.error(`\n[message ${messageCount}] type=${t ?? 'unknown'}`);
      }
    }
  } catch (err) {
    die(`query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const ms = Date.now() - t0;
  console.log(`\n\n── summary ──`);
  console.log(`  messages    : ${messageCount}`);
  console.log(`  duration_ms : ${ms}`);
  console.log(`  chars       : ${assistantText.length}`);
  if (resultError) {
    console.log(`  result error: ${resultError}`);
    process.exit(1);
  }
  if (!/AGENT_SDK_TEST_OK/.test(assistantText)) {
    console.log('  preview     :', assistantText.slice(0, 400).replace(/\n/g, ' '));
    die('Expected AGENT_SDK_TEST_OK in assistant output');
  }
  console.log('  status      : OK');
}

main().catch((e) => die(String(e)));
