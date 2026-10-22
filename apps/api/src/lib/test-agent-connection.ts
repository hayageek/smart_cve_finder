import type { AgentSettingsRow } from '@secscan/shared';

export type AgentTestRequest = AgentSettingsRow & {
  agentRunner?: 'cursor' | 'claude';
};

export type AgentTestResult = {
  ok: boolean;
  runner: 'cursor' | 'claude';
  model: string;
  message: string;
  latencyMs: number;
  detail?: string;
  log?: string;
};

function workersTestUrl(): string {
  const url = process.env.WORKERS_AGENT_TEST_URL?.trim();
  if (url) return url.replace(/\/$/, '');
  return 'http://workers:8082';
}

/**
 * Runs agent tests in the workers container (Claude Agent SDK + Cursor SDK),
 * not in the API process — avoids musl/glibc Claude binary mismatch in API images.
 */
export async function testAgentConnection(body: AgentTestRequest): Promise<AgentTestResult> {
  const base = workersTestUrl();
  const token = process.env.WORKER_AGENT_TEST_TOKEN?.trim();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${base}/test-agent`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint =
      /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(msg)
        ? ` — is the workers service running with WORKER_AGENT_TEST_PORT (default 8082)? Set WORKERS_AGENT_TEST_URL if not using Docker Compose.`
        : '';
    throw new Error(`Could not reach workers agent test server at ${base}${hint} (${msg})`);
  }

  const data = (await res.json()) as AgentTestResult & { error?: string; message?: string };

  if (!res.ok) {
    throw new Error(data.error ?? data.message ?? `Workers test failed (${res.status})`);
  }

  if (typeof data.ok !== 'boolean' || !data.runner) {
    throw new Error('Invalid response from workers agent test server');
  }

  return data;
}
