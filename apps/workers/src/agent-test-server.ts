/**
 * Internal HTTP endpoint so the API can run agent connection tests in this
 * process (glibc + correct Claude Code native binary), not in the API container.
 */

import http from 'http';
import os from 'os';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { resolveAgentRuntime, type AgentSettingsRow } from '@secscan/shared';
import { logger } from './logger.js';
import { workerAgentEnvDefaults } from './agent-runtime-env.js';
import {
  testClaudeAgentSdkConnection,
  testCursorAgentConnection,
  type AgentConnectionTestResult,
} from './agent-connection-test.js';

function mergeTestRow(body: AgentSettingsRow, dbRow: AgentSettingsRow | null): AgentSettingsRow {
  return {
    ...dbRow,
    agentRunner: body.agentRunner ?? dbRow?.agentRunner,
    claudeAgentModel: body.claudeAgentModel ?? dbRow?.claudeAgentModel,
    anthropicBaseUrl: body.anthropicBaseUrl ?? dbRow?.anthropicBaseUrl,
    anthropicApiKey: body.anthropicApiKey ?? dbRow?.anthropicApiKey,
    cursorAgentModel: body.cursorAgentModel ?? dbRow?.cursorAgentModel,
    cursorApiKey: body.cursorApiKey ?? dbRow?.cursorApiKey,
    cursorAgentTimeoutMs: body.cursorAgentTimeoutMs ?? dbRow?.cursorAgentTimeoutMs,
    debugAgent: body.debugAgent ?? dbRow?.debugAgent,
    claudeMaxTokens: body.claudeMaxTokens ?? dbRow?.claudeMaxTokens,
    claudeAgentMaxTurns: body.claudeAgentMaxTurns ?? dbRow?.claudeAgentMaxTurns,
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as unknown;
}

async function handleTestAgent(body: AgentSettingsRow): Promise<AgentConnectionTestResult> {
  const prisma = new PrismaClient();
  try {
    const cfg = (await prisma.workerConfig.findFirst()) as AgentSettingsRow | null;
    const runtime = resolveAgentRuntime(mergeTestRow(body, cfg), workerAgentEnvDefaults());
    const cwd = path.join(os.tmpdir(), 'secscan-agent-test');

    if (runtime.runner === 'claude') {
      if (!runtime.anthropicBaseUrl || !runtime.anthropicApiKey) {
        return {
          ok: false,
          runner: 'claude',
          model: runtime.model,
          message: 'Configure ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY (Settings or .env)',
          latencyMs: 0,
        };
      }
      return testClaudeAgentSdkConnection({
        model: runtime.model,
        baseUrl: runtime.anthropicBaseUrl,
        apiKey: runtime.anthropicApiKey,
        cwd,
      });
    }

    if (!runtime.cursorApiKey) {
      return {
        ok: false,
        runner: 'cursor',
        model: runtime.model,
        message: 'Configure CURSOR_API_KEY (Settings or .env)',
        latencyMs: 0,
      };
    }

    return testCursorAgentConnection({
      apiKey: runtime.cursorApiKey,
      model: runtime.model,
      cwd,
    });
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

export function startAgentTestServer(port: number, token?: string): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/test-agent') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (token) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    try {
      const body = (await readJsonBody(req)) as AgentSettingsRow;
      const result = await handleTestAgent(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'agent-test-server: request failed');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message, error: message }));
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Agent test server listening (POST /test-agent)');
  });

  return server;
}
