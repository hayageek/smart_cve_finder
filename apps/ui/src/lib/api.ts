const BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export type McpConfigResponse = {
  enabled: boolean;
  apiKeyConfigured: boolean;
  publicBaseUrl: string;
  mcpPath: string;
  mcpUrl: string;
  serverName: string;
  tools: string[];
  cursorJson: string;
  claudeJson: string;
  setupSteps: { cursor: string[]; claude: string[] };
};

/** URL for rendered report.md in the browser (HTML). */
export function exploitReportViewUrl(vulnId: string): string {
  return `${BASE}/api/exploits/${vulnId}/report/view`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function requestBlob(path: string): Promise<Blob> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.blob();
}

export const api = {
  // Dashboard
  getDashboardStats: () => request<unknown>('/api/dashboard/stats'),

  // Repos
  previewImport: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return fetch(`${BASE}/api/repos/import/preview`, { method: 'POST', body: form }).then((r) => r.json());
  },
  importRepos: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return fetch(`${BASE}/api/repos/import`, { method: 'POST', body: form }).then((r) => r.json());
  },
  getRepos: (params: Record<string, unknown>) =>
    request<unknown>(`/api/repos?${new URLSearchParams(params as Record<string, string>)}`),
  rescanRepo: (id: string) => request<unknown>(`/api/repos/${id}/rescan`, { method: 'POST' }),
  patchRepoVisibility: (id: string, isPrivate: boolean) =>
    request<unknown>(`/api/repos/${id}/visibility`, { method: 'PATCH', body: JSON.stringify({ isPrivate }) }),
  deleteRepo: (id: string) => request<unknown>(`/api/repos/${id}`, { method: 'DELETE' }),
  deleteRepos: (ids?: string[]) =>
    request<unknown>('/api/repos', { method: 'DELETE', body: JSON.stringify({ ids }) }),

  // Scans
  getQueueStats: () => request<unknown>('/api/scans/queue-stats'),
  getActiveJobs: () => request<unknown>('/api/scans/active-jobs'),
  getFailedJobs: () => request<unknown>('/api/scans/failed-jobs'),
  clearFailedJobs: () => request<unknown>('/api/scans/failed/clear', { method: 'POST' }),
  retryJob: (queueName: string, jobId: string) =>
    request<unknown>(`/api/scans/failed/${queueName}/${jobId}/retry`, { method: 'POST' }),
  getScanHistory: (params: Record<string, unknown>) =>
    request<unknown>(`/api/scans/history?${new URLSearchParams(params as Record<string, string>)}`),
  getScanDetail: (id: string) => request<unknown>(`/api/scans/${id}`),

  // Vulnerabilities
  getVulnerabilities: (params: Record<string, unknown>) =>
    request<unknown>(`/api/vulnerabilities?${new URLSearchParams(params as Record<string, string>)}`),
  getVulnerability: (id: string) => request<unknown>(`/api/vulnerabilities/${id}`),
  setFalsePositive: (id: string, value: boolean) =>
    request<unknown>(`/api/vulnerabilities/${id}/false-positive`, { method: 'PATCH', body: JSON.stringify({ value }) }),
  generateExploit: (id: string) =>
    request<unknown>(`/api/vulnerabilities/${id}/generate-exploit`, { method: 'POST' }),
  bulkExploit: (body: { vulnIds: string[]; onlyNew?: boolean }) =>
    request<{ queued: number }>('/api/vulnerabilities/bulk-exploit', { method: 'POST', body: JSON.stringify(body) }),
  clearVulnerabilities: () => request<unknown>('/api/vulnerabilities', { method: 'DELETE' }),
  getDroppedVulns: (params: Record<string, unknown>) =>
    request<unknown>(`/api/vulnerabilities/dropped?${new URLSearchParams(params as Record<string, string>)}`),
  promoteDropped: (id: string) =>
    request<unknown>(`/api/vulnerabilities/dropped/${id}/promote`, { method: 'POST' }),
  clearDroppedVulns: () => request<unknown>('/api/vulnerabilities/dropped', { method: 'DELETE' }),

  // Exploits
  getExploits: (params: Record<string, unknown>) =>
    request<unknown>(`/api/exploits?${new URLSearchParams(params as Record<string, string>)}`),
  downloadExploit: (id: string) => requestBlob(`/api/exploits/${id}/download`),
  downloadExploitFile: (id: string, filename: string) => requestBlob(`/api/exploits/${id}/files/${filename}`),
  getExploitReport: (id: string) => request<{ content: string }>(`/api/exploits/${id}/report`),
  clearExploits: () => request<unknown>('/api/exploits', { method: 'DELETE' }),

  // Workers
  getWorkerConfig: () => request<unknown>('/api/workers/config'),
  updateWorkerConfig: (data: Record<string, unknown>) =>
    request<unknown>('/api/workers/config', { method: 'PATCH', body: JSON.stringify(data) }),
  getWorkerQueueStats: () => request<unknown>('/api/workers/queue-stats'),
  scannerPause: () => request<unknown>('/api/workers/scanner/pause', { method: 'POST' }),
  scannerResume: () => request<unknown>('/api/workers/scanner/resume', { method: 'POST' }),
  scannerDrain: () => request<unknown>('/api/workers/scanner/drain', { method: 'POST' }),
  exploitPause: () => request<unknown>('/api/workers/exploit/pause', { method: 'POST' }),
  exploitResume: () => request<unknown>('/api/workers/exploit/resume', { method: 'POST' }),
  exploitDrain: () => request<unknown>('/api/workers/exploit/drain', { method: 'POST' }),
  clearQueue: (name: string) =>
    request<unknown>(`/api/workers/queues/${name}/clear`, { method: 'POST' }),
  getWorkerLogs: (tail = 500) =>
    request<{ lines: Array<{ timestamp: string; level: string; worker: string; message: string; jobId?: string }>; total: number }>(`/api/workers/logs?tail=${tail}`),
  downloadWorkerLogs: () => requestBlob('/api/workers/logs/download'),
  clearWorkerLogs: () => request<unknown>('/api/workers/logs', { method: 'DELETE' }),

  // Settings
  getMcpConfig: () => request<McpConfigResponse>('/api/settings/mcp-config'),
  getEnvConfig: () => request<Record<string, string>>('/api/settings/env'),
  clearData: (target: string) =>
    request<unknown>('/api/settings/clear', { method: 'POST', body: JSON.stringify({ target }) }),
  downloadLogs: () => requestBlob('/api/settings/logs'),
  getLogTail: (lines: number) => fetch(`${BASE}/api/settings/logs?tail=${lines}`).then((r) => r.text()),
};
