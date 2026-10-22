#!/usr/bin/env node
/**
 * CLI to test production runClaudeSkill() (@anthropic-ai/claude-agent-sdk).
 *
 * Usage (from repo root):
 *   npm run claude-test -w apps/workers
 *   npm run claude-test -w apps/workers -- --model z-ai/glm-5.3-flash --prompt "Reply with exactly: ok"
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { claudeAgentMaxTurns, runClaudeSkill } from './claude-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
dotenv.config({ path: path.join(repoRoot, '.env') });

const argv = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return argv.includes(name);
}
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const modelId = getFlag('--model') ?? process.env.CLAUDE_AGENT_MODEL ?? 'openai/glm-5.2';
const prompt =
  getFlag('--prompt') ??
  'Reply with exactly one line: MODEL_TEST_OK (no other text).';
const baseUrl = nonEmpty(getFlag('--base-url') ?? process.env.ANTHROPIC_BASE_URL);
const apiKey = nonEmpty(getFlag('--api-key') ?? process.env.ANTHROPIC_API_KEY);
const stream = !hasFlag('--no-stream');
const skillPath = getFlag('--skill') ?? path.join(repoRoot, '.cursor/skills/exploit-generator/SKILL.md');

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function printHeader(): void {
  console.log('\n── Claude Agent SDK test (runClaudeSkill) ──');
  console.log('  runner     : claude (agent-sdk)');
  console.log(`  model      : ${modelId}`);
  console.log(`  url        : ${baseUrl ?? '(not set)'}`);
  console.log(`  api-key    : ${apiKey ? 'set' : '(not set)'}`);
  console.log(`  max-turns  : ${claudeAgentMaxTurns()}`);
  console.log(`  cwd        : ${repoRoot}`);
  console.log(`  skill      : ${skillPath}`);
  console.log(`  prompt     : ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`);
  console.log('────────────────────────────────────────────\n');
}

async function cmdRun(): Promise<void> {
  printHeader();

  const t0 = Date.now();
  let outputText = '';

  try {
    if (stream) process.stdout.write('\n── stream ──\n');
    const { text } = await runClaudeSkill({
      skillPath,
      promptSuffix: prompt,
      cwd: repoRoot,
      model: modelId,
      anthropicBaseUrl: baseUrl,
      anthropicApiKey: apiKey,
      debug: true,
      onChunk: stream
        ? (delta) => {
            outputText += delta;
            process.stdout.write(delta);
          }
        : undefined,
    });
    outputText = outputText || text;
    if (stream) process.stdout.write('\n── end stream ──\n\n');

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('── result ──');
    console.log('  runner     : claude (agent-sdk)');
    console.log(`  model      : ${modelId}`);
    console.log(`  url        : ${baseUrl ?? '(not set)'}`);
    console.log(`  elapsed    : ${elapsed}s`);
    console.log(`  chars      : ${outputText.length}`);
    if (outputText && !stream) {
      console.log('── text ──');
      console.log(outputText);
    }
    if (!/MODEL_TEST_OK/.test(outputText)) {
      console.warn('  warn       : expected MODEL_TEST_OK in output');
      process.exit(2);
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
claude-agent-test — exercise runClaudeSkill() with @anthropic-ai/claude-agent-sdk

  npm run claude-test -w apps/workers
  npm run claude-test -w apps/workers -- --model openai/glm-5.2 --prompt "Say hello"

Options:
  --model <id>         Default: CLAUDE_AGENT_MODEL or openai/glm-5.2
  --prompt <text>      Appended after skill path in the agent prompt
  --skill <path>       SKILL.md path (default: exploit-generator)
  --base-url <url>     Override ANTHROPIC_BASE_URL
  --api-key <key>      Override ANTHROPIC_API_KEY
  --no-stream          Skip live streaming to stdout

Env loaded from: ${path.join(repoRoot, '.env')}
`);
}

if (hasFlag('--help') || hasFlag('-h')) {
  printHelp();
  process.exit(0);
}

await cmdRun();
