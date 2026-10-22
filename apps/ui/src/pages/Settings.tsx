import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { Layout } from '../components/Layout.tsx';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/Card.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Input } from '../components/ui/Input.tsx';
import { Select } from '../components/ui/Select.tsx';
import { Tabs } from '../components/ui/Tabs.tsx';
import { ConfirmDialog } from '../components/ui/Dialog.tsx';
import { api, type McpConfigResponse } from '../lib/api.ts';
import { useToast } from '../components/ui/Toast.tsx';
import type { WorkerConfigView } from '@secscan/shared';

const CLEAR_TARGETS = [
  { key: 'queue-scan', label: 'Scan Queue (repo-scan-queue)', color: 'outline' },
  { key: 'queue-exploit', label: 'Exploit Queue (exploit-gen-queue)', color: 'outline' },
  { key: 'scan-history', label: 'Scan History', color: 'outline' },
  { key: 'vulnerabilities', label: 'Confirmed Vulnerabilities', color: 'outline' },
  { key: 'secrets', label: 'All Secrets', color: 'outline' },
  { key: 'dropped-vulns', label: 'Dropped Vulnerabilities', color: 'outline' },
  { key: 'exploits', label: 'Exploit Artifacts (files + DB)', color: 'outline' },
  { key: 'repos', label: 'All Repositories', color: 'destructive' },
  { key: 'everything', label: 'Reset Everything (nuclear)', color: 'destructive' },
] as const;

function CopyBlock({ label, json, steps }: { label: string; json: string; steps: string[] }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{label}</CardTitle>
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? 'Copied' : 'Copy JSON'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        <pre className="text-xs font-mono bg-muted rounded-md p-3 overflow-x-auto max-h-64">{json}</pre>
      </CardContent>
    </Card>
  );
}

function McpTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['mcp-config'],
    queryFn: () => api.getMcpConfig(),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading MCP configuration…</p>;
  if (error) return <p className="text-sm text-destructive">Failed to load MCP config: {String(error)}</p>;
  if (!data) return null;

  return <McpTabContent config={data} />;
}

function McpTabContent({ config }: { config: McpConfigResponse }) {
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex flex-wrap gap-2">
        <span className={`text-xs px-2 py-1 rounded-full border ${config.enabled ? 'bg-green-500/10 border-green-500/30' : 'bg-muted border-border'}`}>
          MCP {config.enabled ? 'enabled' : 'disabled'}
        </span>
        <span className={`text-xs px-2 py-1 rounded-full border ${config.apiKeyConfigured ? 'bg-green-500/10 border-green-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
          API key {config.apiKeyConfigured ? 'configured' : 'missing'}
        </span>
        <span className="text-xs px-2 py-1 rounded-full border border-border bg-muted font-mono">
          {config.mcpUrl}
        </span>
      </div>

      {!config.enabled && (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          Set <code className="font-mono text-xs">MCP_ENABLED=true</code> in the API <code className="font-mono text-xs">.env</code> and restart the API container.
        </p>
      )}
      {!config.apiKeyConfigured && (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          Set <code className="font-mono text-xs">MCP_API_KEY</code> in the API <code className="font-mono text-xs">.env</code> and restart the API — the JSON below will then include your key instead of{' '}
          <code className="font-mono text-xs">{'${env:MCP_API_KEY}'}</code>.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">MCP tools</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc list-inside text-sm space-y-1 font-mono">
            {config.tools.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <CopyBlock label="Cursor" json={config.cursorJson} steps={config.setupSteps.cursor} />

      <CopyBlock label="Claude Desktop" json={config.claudeJson} steps={[
        ...config.setupSteps.claude,
        'macOS config: ~/Library/Application Support/Claude/claude_desktop_config.json',
        'Windows config: %APPDATA%\\Claude\\claude_desktop_config.json',
      ]} />
    </div>
  );
}

function GeneralTab() {
  const { data: env } = useQuery({ queryKey: ['env-config'], queryFn: () => api.getEnvConfig() });
  return (
    <div>
      <p className="text-sm text-muted-foreground mb-3">
        Environment variables visible to the <strong>API</strong> process (same <code className="text-xs">.env</code> as Docker Compose when using containers).
        Restart the API after changing <code className="text-xs">.env</code>. Sensitive values are masked.
      </p>
      <div className="rounded-md border border-border overflow-hidden">
        {env && Object.entries(env).map(([k, v]) => (
          <div key={k} className="flex items-start gap-4 px-3 py-2 border-b border-border last:border-0 hover:bg-accent/30">
            <span className="font-mono text-xs text-muted-foreground w-60 flex-shrink-0">{k}</span>
            <span className="font-mono text-xs break-all">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type AgentTestResult = {
  ok: boolean;
  runner: 'cursor' | 'claude';
  model: string;
  message: string;
  latencyMs: number;
  detail?: string;
  log?: string;
};

function AgentTestResultPanel({ result }: { result: AgentTestResult }) {
  return (
    <div
      className={`rounded-md border px-3 py-2 text-sm ${
        result.ok
          ? 'border-green-500/40 bg-green-500/10 text-green-900 dark:text-green-100'
          : 'border-destructive/40 bg-destructive/10 text-destructive'
      }`}
    >
      <p className="font-medium">
        {result.ok ? 'Connection OK' : 'Connection failed'} — {result.model}{' '}
        <span className="text-xs font-normal opacity-80">({result.latencyMs} ms)</span>
      </p>
      <p className="text-xs mt-1 break-words">{result.message}</p>
      {result.detail && (
        <pre className="text-xs mt-2 whitespace-pre-wrap break-words opacity-90">{result.detail}</pre>
      )}
      {result.log && <p className="text-xs mt-2 opacity-80 font-mono">{result.log}</p>}
    </div>
  );
}

function ScannerTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: config } = useQuery({ queryKey: ['worker-config'], queryFn: () => api.getWorkerConfig() as Promise<WorkerConfigView> });
  const [testResult, setTestResult] = useState<AgentTestResult | null>(null);
  const [form, setForm] = useState({
    exploitMinSeverity: 'HIGH',
    exploitIncludeDropped: false,
    dedupWindowHours: 24,
    workspaceCleanupHours: 48,
    agentRunner: 'cursor',
    cursorAgentModel: 'composer-2.5',
    cursorApiKey: '',
    cursorAgentTimeoutMs: 300_000,
    debugAgent: false,
    claudeAgentModel: 'openai/glm-5.2',
    claudeMaxTokens: 16_384,
    claudeAgentMaxTurns: 50,
    anthropicBaseUrl: '',
    anthropicApiKey: '',
  });

  useEffect(() => {
    if (config) setForm({
      exploitMinSeverity: config.exploitMinSeverity,
      exploitIncludeDropped: config.exploitIncludeDropped,
      dedupWindowHours: config.dedupWindowHours,
      workspaceCleanupHours: config.workspaceCleanupHours,
      agentRunner: config.agentRunner === 'claude' ? 'claude' : 'cursor',
      cursorAgentModel: config.cursorAgentModel ?? 'composer-2.5',
      cursorApiKey: config.cursorApiKey ?? '',
      cursorAgentTimeoutMs: config.cursorAgentTimeoutMs ?? 300_000,
      debugAgent: config.debugAgent ?? false,
      claudeAgentModel: config.claudeAgentModel || 'openai/glm-5.2',
      claudeMaxTokens: config.claudeMaxTokens ?? 16_384,
      claudeAgentMaxTurns: config.claudeAgentMaxTurns ?? 50,
      anthropicBaseUrl: config.anthropicBaseUrl ?? '',
      anthropicApiKey: config.anthropicApiKey ?? '',
    });
  }, [config]);

  const runner: 'cursor' | 'claude' = form.agentRunner === 'claude' ? 'claude' : 'cursor';

  const buildSavePayload = (): Record<string, unknown> => {
    const shared = {
      exploitMinSeverity: form.exploitMinSeverity,
      exploitIncludeDropped: form.exploitIncludeDropped,
      dedupWindowHours: form.dedupWindowHours,
      workspaceCleanupHours: form.workspaceCleanupHours,
      agentRunner: runner,
    };
    if (runner === 'cursor') {
      return {
        ...shared,
        cursorAgentModel: form.cursorAgentModel,
        cursorApiKey: form.cursorApiKey,
        cursorAgentTimeoutMs: form.cursorAgentTimeoutMs,
        debugAgent: form.debugAgent,
      };
    }
    return {
      ...shared,
      claudeAgentModel: form.claudeAgentModel,
      claudeMaxTokens: form.claudeMaxTokens,
      claudeAgentMaxTurns: form.claudeAgentMaxTurns,
      anthropicBaseUrl: form.anthropicBaseUrl,
      anthropicApiKey: form.anthropicApiKey,
      debugAgent: form.debugAgent,
    };
  };

  const testPayload = (): Record<string, unknown> => {
    const base = { agentRunner: runner, debugAgent: form.debugAgent };
    if (runner === 'cursor') {
      return {
        ...base,
        cursorAgentModel: form.cursorAgentModel,
        cursorApiKey: form.cursorApiKey || undefined,
        cursorAgentTimeoutMs: form.cursorAgentTimeoutMs,
      };
    }
    return {
      ...base,
      claudeAgentModel: form.claudeAgentModel,
      claudeMaxTokens: form.claudeMaxTokens,
      anthropicBaseUrl: form.anthropicBaseUrl,
      anthropicApiKey: form.anthropicApiKey || undefined,
    };
  };

  const update = useMutation({
    mutationFn: () => api.updateWorkerConfig(buildSavePayload()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['worker-config'] }),
    meta: { successMessage: 'Scanner settings saved' },
  });

  const testAgent = useMutation({
    mutationFn: () => api.testAgentConnection(testPayload()),
    meta: { silent: true },
    onSuccess: (result) => {
      setTestResult(result);
      if (result.ok) toast.success('Agent test passed', `${result.runner} · ${result.model}`);
      else toast.error('Agent test failed', result.message);
    },
    onError: (err) => {
      setTestResult({
        ok: false,
        runner: form.agentRunner === 'claude' ? 'claude' : 'cursor',
        model: form.agentRunner === 'claude' ? form.claudeAgentModel : form.cursorAgentModel,
        message: err instanceof Error ? err.message : String(err),
        latencyMs: 0,
      });
      toast.error('Agent test failed', err instanceof Error ? err.message : String(err));
    },
  });

  return (
    <div className="space-y-4 max-w-lg">
      <div>
        <label className="text-sm font-medium">Agent runner</label>
        <p className="text-xs text-muted-foreground">
          Saved to the database and picked up by workers on the next job — no rebuild. Empty secret fields keep using <code className="text-xs">.env</code>.
        </p>
        <Select
          className="mt-1 w-full"
          value={runner}
          onChange={(e) => {
            const next = e.target.value === 'claude' ? 'claude' : 'cursor';
            setTestResult(null);
            setForm((f) => ({ ...f, agentRunner: next }));
          }}
        >
          <option value="cursor">cursor (@cursor/sdk)</option>
          <option value="claude">claude (Claude Agent SDK)</option>
        </Select>
        {config?.agentRunnerFromEnv && runner === config.agentRunner && (
          <p className="text-xs text-green-600 dark:text-green-400 mt-1">Runner inherited from .env until you save a choice here.</p>
        )}
      </div>

      {runner === 'cursor' && (
        <Card key="cursor-agent-settings">
          <CardHeader><CardTitle className="text-base">Cursor settings</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium">CURSOR_AGENT_MODEL</label>
              <Input className="mt-1" value={form.cursorAgentModel} onChange={(e) => setForm((f) => ({ ...f, cursorAgentModel: e.target.value }))} />
              {config?.cursorAgentModelFromEnv && (
                <p className="text-xs text-green-600 dark:text-green-400 mt-1">Effective from .env: {config.cursorAgentModel}</p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium">CURSOR_API_KEY</label>
              <Input
                type="password"
                autoComplete="off"
                className="mt-1"
                placeholder={config?.cursorApiKeyFromEnv ? '•••••••• (from .env)' : undefined}
                value={form.cursorApiKey}
                onChange={(e) => setForm((f) => ({ ...f, cursorApiKey: e.target.value }))}
              />
              {config?.cursorApiKeyFromEnv && (
                <p className="text-xs text-green-600 dark:text-green-400 mt-1">Key set in .env — enter here only to override.</p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium">CURSOR_AGENT_TIMEOUT_MS</label>
              <Input
                type="number"
                min={1000}
                className="mt-1"
                value={form.cursorAgentTimeoutMs}
                onChange={(e) => setForm((f) => ({ ...f, cursorAgentTimeoutMs: Number(e.target.value) }))}
              />
              {config?.cursorAgentTimeoutMsFromEnv && (
                <p className="text-xs text-muted-foreground mt-1">Default from .env: {config.cursorAgentTimeoutMs} ms</p>
              )}
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">DEBUG_AGENT</p>
                <p className="text-xs text-muted-foreground">Verbose agent logging in workers</p>
              </div>
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, debugAgent: !f.debugAgent }))}
                className={`relative w-9 h-5 rounded-full transition-colors ${form.debugAgent ? 'bg-primary' : 'bg-muted'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${form.debugAgent ? 'translate-x-4' : ''}`} />
              </button>
            </div>
            <div className="pt-2 border-t border-border space-y-3">
              <p className="text-xs text-muted-foreground">
                Runs the same check as <code className="text-xs">npm run cursor-test -w apps/workers</code> (unsaved values above).
              </p>
              <Button
                variant="outline"
                size="sm"
                loading={testAgent.isPending}
                onClick={() => {
                  setTestResult(null);
                  testAgent.mutate();
                }}
              >
                Test Cursor connection
              </Button>
              {testResult?.runner === 'cursor' && (
                <AgentTestResultPanel result={testResult} />
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {runner === 'claude' && (
        <Card key="claude-agent-settings">
          <CardHeader><CardTitle className="text-base">Claude settings</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium">CLAUDE_AGENT_MODEL</label>
              <Input className="mt-1" value={form.claudeAgentModel} onChange={(e) => setForm((f) => ({ ...f, claudeAgentModel: e.target.value }))} />
              {config?.claudeAgentModelFromEnv && (
                <p className="text-xs text-green-600 dark:text-green-400 mt-1">Effective from .env: {config.claudeAgentModel}</p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium">CLAUDE_MAX_TOKENS</label>
              <Input
                type="number"
                min={1}
                className="mt-1"
                value={form.claudeMaxTokens}
                onChange={(e) => setForm((f) => ({ ...f, claudeMaxTokens: Number(e.target.value) }))}
              />
              {config?.claudeMaxTokensFromEnv && (
                <p className="text-xs text-muted-foreground mt-1">Default from .env: {config.claudeMaxTokens}</p>
              )}
              <p className="text-xs text-muted-foreground mt-1">Legacy; not used by the Claude Agent SDK runner.</p>
            </div>
            <div>
              <label className="text-sm font-medium">CLAUDE_AGENT_MAX_TURNS</label>
              <Input
                type="number"
                min={1}
                max={500}
                className="mt-1"
                value={form.claudeAgentMaxTurns}
                onChange={(e) => setForm((f) => ({ ...f, claudeAgentMaxTurns: Number(e.target.value) }))}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Max agent turns per CVE skill or exploit run. Raise this if logs show &quot;Reached maximum number of turns (50)&quot;.
              </p>
              {config?.claudeAgentMaxTurnsFromEnv && (
                <p className="text-xs text-muted-foreground mt-1">Default from .env: {config.claudeAgentMaxTurns}</p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium">ANTHROPIC_BASE_URL</label>
              <Input className="mt-1" placeholder="https://openrouter.ai/api" value={form.anthropicBaseUrl} onChange={(e) => setForm((f) => ({ ...f, anthropicBaseUrl: e.target.value }))} />
              {config?.anthropicBaseUrlFromEnv && config.anthropicBaseUrl && (
                <p className="text-xs text-green-600 dark:text-green-400 mt-1">From .env: {config.anthropicBaseUrl}</p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium">ANTHROPIC_API_KEY</label>
              <Input
                type="password"
                autoComplete="off"
                className="mt-1"
                placeholder={config?.anthropicApiKeyFromEnv ? '•••••••• (from .env)' : undefined}
                value={form.anthropicApiKey}
                onChange={(e) => setForm((f) => ({ ...f, anthropicApiKey: e.target.value }))}
              />
              {config?.anthropicApiKeyFromEnv && (
                <p className="text-xs text-green-600 dark:text-green-400 mt-1">Key set in .env — enter here only to override.</p>
              )}
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">DEBUG_AGENT</p>
                <p className="text-xs text-muted-foreground">Also applies to Claude agent runs in workers</p>
              </div>
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, debugAgent: !f.debugAgent }))}
                className={`relative w-9 h-5 rounded-full transition-colors ${form.debugAgent ? 'bg-primary' : 'bg-muted'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${form.debugAgent ? 'translate-x-4' : ''}`} />
              </button>
            </div>
            <div className="pt-2 border-t border-border space-y-3">
              <p className="text-xs text-muted-foreground">
                Runs the same check as <code className="text-xs">npm run claude-agent-sdk-test -w apps/workers</code> (unsaved values above).
              </p>
              <Button
                variant="outline"
                size="sm"
                loading={testAgent.isPending}
                onClick={() => {
                  setTestResult(null);
                  testAgent.mutate();
                }}
              >
                Test Claude connection
              </Button>
              {testResult?.runner === 'claude' && (
                <AgentTestResultPanel result={testResult} />
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <div>
        <label className="text-sm font-medium">Min Severity for Exploit Generation</label>
        <Select className="mt-1 w-full" value={form.exploitMinSeverity} onChange={(e) => setForm((f) => ({ ...f, exploitMinSeverity: e.target.value }))}>
          {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Include Dropped Vulns in Exploit Gen</p>
          <p className="text-xs text-muted-foreground">Also run exploit-generator on dropped findings</p>
        </div>
        <button
          onClick={() => setForm((f) => ({ ...f, exploitIncludeDropped: !f.exploitIncludeDropped }))}
          className={`relative w-9 h-5 rounded-full transition-colors ${form.exploitIncludeDropped ? 'bg-primary' : 'bg-muted'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${form.exploitIncludeDropped ? 'translate-x-4' : ''}`} />
        </button>
      </div>
      <div>
        <label className="text-sm font-medium">Dedup Window (hours)</label>
        <p className="text-xs text-muted-foreground">0 = always re-scan</p>
        <Input type="number" min={0} className="mt-1" value={form.dedupWindowHours} onChange={(e) => setForm((f) => ({ ...f, dedupWindowHours: Number(e.target.value) }))} />
      </div>
      <div>
        <label className="text-sm font-medium">Workspace Cleanup (hours)</label>
        <p className="text-xs text-muted-foreground">Legacy setting — scanner workspaces are now cleaned immediately after each scan</p>
        <Input type="number" min={0} className="mt-1" value={form.workspaceCleanupHours} onChange={(e) => setForm((f) => ({ ...f, workspaceCleanupHours: Number(e.target.value) }))} />
      </div>
      <Button loading={update.isPending} onClick={() => update.mutate()}>Save Settings</Button>
    </div>
  );
}

function NotificationsTab() {
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ['worker-config'], queryFn: () => api.getWorkerConfig() as Promise<WorkerConfigView> });
  const [form, setForm] = useState({ notifyWebhookUrl: '', notifyOnCritical: true, notifyOnScanComplete: false });

  useEffect(() => {
    if (config) setForm({
      notifyWebhookUrl: config.notifyWebhookUrl ?? '',
      notifyOnCritical: config.notifyOnCritical,
      notifyOnScanComplete: config.notifyOnScanComplete,
    });
  }, [config]);

  const update = useMutation({
    mutationFn: (data: typeof form) => api.updateWorkerConfig(data as Record<string, unknown>),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['worker-config'] }),
    meta: { successMessage: 'Notification settings saved' },
  });

  return (
    <div className="space-y-4 max-w-sm">
      <div>
        <label className="text-sm font-medium">Webhook URL</label>
        <p className="text-xs text-muted-foreground">POST JSON payload to this URL on events</p>
        <Input className="mt-1" placeholder="https://hooks.slack.com/..." value={form.notifyWebhookUrl} onChange={(e) => setForm((f) => ({ ...f, notifyWebhookUrl: e.target.value }))} />
      </div>
      {[['notifyOnCritical', 'Notify on CRITICAL vulnerability found'], ['notifyOnScanComplete', 'Notify on scan complete']].map(([key, label]) => (
        <div key={key} className="flex items-center justify-between">
          <p className="text-sm">{label}</p>
          <button
            onClick={() => setForm((f) => ({ ...f, [key]: !f[key as keyof typeof f] }))}
            className={`relative w-9 h-5 rounded-full transition-colors ${form[key as keyof typeof form] ? 'bg-primary' : 'bg-muted'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${form[key as keyof typeof form] ? 'translate-x-4' : ''}`} />
          </button>
        </div>
      ))}
      <Button loading={update.isPending} onClick={() => update.mutate(form)}>Save</Button>
    </div>
  );
}

function DataManagementTab() {
  const qc = useQueryClient();
  const clear = useMutation({
    mutationFn: (target: string) => api.clearData(target),
    onSuccess: () => {
      qc.invalidateQueries();
    },
    meta: { successMessage: 'Data cleared successfully' },
  });

  return (
    <div className="space-y-3 max-w-lg">
      <p className="text-sm text-muted-foreground">All destructive actions require confirmation. Data cannot be recovered.</p>
      {CLEAR_TARGETS.map((target) => (
        <ConfirmDialog
          key={target.key}
          title={`Clear: ${target.label}`}
          description={`This will permanently delete ${target.label.toLowerCase()}. This cannot be undone.`}
          requireTyped={target.color === 'destructive' ? 'DELETE' : undefined}
          confirmText="Clear"
          onConfirm={() => clear.mutate(target.key)}
        >
          {(open) => (
            <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
              <span className="text-sm">{target.label}</span>
              <Button
                size="sm"
                variant={target.color === 'destructive' ? 'destructive' : 'outline'}
                onClick={open}
                loading={clear.isPending}
              >
                Clear
              </Button>
            </div>
          )}
        </ConfirmDialog>
      ))}
    </div>
  );
}

export default function Settings() {
  return (
    <Layout title="Settings" subtitle="Configuration, notifications, and data management">
      <Tabs
        tabs={[
          { id: 'general', label: 'General', content: <GeneralTab /> },
          { id: 'mcp', label: 'MCP Integration', content: <McpTab /> },
          { id: 'scanner', label: 'Scanner', content: <ScannerTab /> },
          { id: 'notifications', label: 'Notifications', content: <NotificationsTab /> },
          { id: 'data', label: 'Data Management', content: <DataManagementTab /> },
        ]}
      />
    </Layout>
  );
}
