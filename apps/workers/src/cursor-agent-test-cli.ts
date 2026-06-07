#!/usr/bin/env node
/**
 * Minimal CLI to test @cursor/sdk Agent.create.
 *
 * Usage (from repo root):
 *   npm run cursor-test -w apps/workers
 *   npm run cursor-test -w apps/workers -- --list-models
 *   npm run cursor-test -w apps/workers -- --model composer-2.5 --prompt "Reply with exactly: ok"
 *   npm run cursor-test -w apps/workers -- --cwd /path/to/repo
 *
 * Options:
 *   --model <id>       Model id (default: CURSOR_AGENT_MODEL or composer-2.5)
 *   --cwd <dir>        local.cwd (default: repo root)
 *   --prompt <text>    Prompt sent via agent.send (default: short echo test)
 *   --api-key <key>    CURSOR_API_KEY override
 *   --list-models      Print models/variants from Cursor.models.list() and exit
 *   --no-stream        Wait for result only (no live stdout chunks)
 */

import { setMaxListeners } from 'events';
import dotenv from 'dotenv';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Agent, Cursor } from '@cursor/sdk';
import { buildModelSelection } from './cursor-runner.js';

setMaxListeners(100);

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

const apiKey = getFlag('--api-key') ?? process.env.CURSOR_API_KEY;
const modelId = getFlag('--model') ?? process.env.CURSOR_AGENT_MODEL ?? 'composer-2.5';
const cwd = path.resolve(getFlag('--cwd') ?? repoRoot);
const prompt =
  getFlag('--prompt') ??
  'Reply with exactly one line: MODEL_TEST_OK (no other text).';
const listModels = hasFlag('--list-models');
const stream = !hasFlag('--no-stream');

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function printHeader(model: ReturnType<typeof buildModelSelection>): void {
  console.log('\n── Agent.create test ──');
  console.log(`  model.id   : ${model.id}`);
  console.log(
    `  model.params: ${
      model.params?.length
        ? JSON.stringify(model.params)
        : '(none — SDK uses model default variant)'
    }`,
  );
  console.log(`  local.cwd  : ${cwd} (exists=${existsSync(cwd)})`);
  console.log(`  prompt     : ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`);
  console.log('────────────────────────\n');
}

async function cmdListModels(): Promise<void> {
  if (!apiKey) die('CURSOR_API_KEY is required for --list-models');
  const models = await Cursor.models.list({ apiKey });
  const hits = models.filter(
    (m) =>
      m.id.includes('composer') ||
      m.aliases?.some((a) => a.includes('composer')),
  );
  console.log(JSON.stringify(hits.length ? hits : models, null, 2));
}

async function cmdRun(): Promise<void> {
  if (!apiKey) {
    die(
      'CURSOR_API_KEY is required.\n' +
        'Set it in .env or pass --api-key. Get a key at https://cursor.com/settings',
    );
  }
  if (!existsSync(cwd)) {
    die(`cwd does not exist: ${cwd}`);
  }

  const model = buildModelSelection(modelId);
  printHeader(model);

  const t0 = Date.now();
  const agent = await Agent.create({
    apiKey,
    model,
    local: { cwd },
  });

  let outputText = '';
  try {
    const run = await agent.send(prompt);

    if (stream && run.supports('stream')) {
      process.stdout.write('\n── stream ──\n');
      for await (const event of run.stream()) {
        const e = event as {
          type?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        if (e.type === 'assistant' && e.message?.content) {
          for (const block of e.message.content) {
            if (block.type === 'text' && block.text) {
              process.stdout.write(block.text);
              outputText += block.text;
            }
          }
        }
      }
      process.stdout.write('\n── end stream ──\n\n');
    }

    const result = await run.wait();
    if (!outputText && result.result) outputText = result.result;

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('── result ──');
    console.log(`  status   : ${result.status}`);
    console.log(`  run id   : ${result.id ?? '(none)'}`);
    console.log(`  model    : ${JSON.stringify(result.model ?? '(not returned)')}`);
    console.log(`  elapsed  : ${elapsed}s`);
    console.log(`  chars    : ${outputText.length}`);
    if (outputText && !stream) {
      console.log('── text ──');
      console.log(outputText);
    }

    if (result.status === 'error') {
      process.exit(2);
    }
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

function printHelp(): void {
  console.log(`
cursor-agent-test — exercise Agent.create with @cursor/sdk

  npm run cursor-test -w apps/workers
  npm run cursor-test -w apps/workers -- --list-models
  npm run cursor-test -w apps/workers -- --model composer-2.5 --prompt "Say hello"

Options:
  --model <id>         Default: CURSOR_AGENT_MODEL or composer-2.5
  --cwd <dir>          local.cwd (default: repo root)
  --prompt <text>      agent.send prompt
  --api-key <key>      Override CURSOR_API_KEY
  --list-models        Show Cursor.models.list() and exit
  --no-stream          Skip live streaming to stdout

Env loaded from: ${path.join(repoRoot, '.env')}
`);
}

if (hasFlag('--help') || hasFlag('-h')) {
  printHelp();
  process.exit(0);
}

try {
  if (listModels) {
    await cmdListModels();
  } else {
    await cmdRun();
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
