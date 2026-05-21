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
import type { WorkerConfig } from '@secscan/shared';

const CLEAR_TARGETS = [
  { key: 'queue-scan', label: 'Scan Queue (repo-scan-queue)', color: 'outline' },
  { key: 'queue-cve', label: 'CVE Queue (cve-scan-queue)', color: 'outline' },
  { key: 'queue-exploit', label: 'Exploit Queue (exploit-gen-queue)', color: 'outline' },
  { key: 'scan-history', label: 'Scan History', color: 'outline' },
  { key: 'vulnerabilities', label: 'Confirmed Vulnerabilities', color: 'outline' },
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
          Set <code className="font-mono text-xs">MCP_API_KEY</code> in the API <code className="font-mono text-xs">.env</code>, export the same value as{' '}
          <code className="font-mono text-xs">MCP_API_KEY</code> in your shell for Cursor/Claude config interpolation.
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
      <p className="text-sm text-muted-foreground mb-3">Active environment variables. Sensitive values are masked.</p>
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

function ScannerTab() {
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ['worker-config'], queryFn: () => api.getWorkerConfig() as Promise<WorkerConfig> });
  const [form, setForm] = useState({ exploitMinSeverity: 'HIGH', exploitIncludeDropped: false, dedupWindowHours: 24, workspaceCleanupHours: 48 });

  useEffect(() => {
    if (config) setForm({
      exploitMinSeverity: config.exploitMinSeverity,
      exploitIncludeDropped: config.exploitIncludeDropped,
      dedupWindowHours: config.dedupWindowHours,
      workspaceCleanupHours: config.workspaceCleanupHours,
    });
  }, [config]);

  const update = useMutation({
    mutationFn: (data: typeof form) => api.updateWorkerConfig(data as Record<string, unknown>),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['worker-config'] }),
  });

  return (
    <div className="space-y-4 max-w-sm">
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
        <p className="text-xs text-muted-foreground">Delete cloned repos after N hours</p>
        <Input type="number" min={0} className="mt-1" value={form.workspaceCleanupHours} onChange={(e) => setForm((f) => ({ ...f, workspaceCleanupHours: Number(e.target.value) }))} />
      </div>
      <Button loading={update.isPending} onClick={() => update.mutate(form)}>Save Settings</Button>
    </div>
  );
}

function NotificationsTab() {
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ['worker-config'], queryFn: () => api.getWorkerConfig() as Promise<WorkerConfig> });
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
