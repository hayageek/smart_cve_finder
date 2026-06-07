import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, Pause, Square, Download, Trash, Zap, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { Layout } from '../components/Layout.tsx';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/Card.tsx';
import { Button } from '../components/ui/Button.tsx';
import { ConfirmDialog } from '../components/ui/Dialog.tsx';
import { Badge } from '../components/ui/Badge.tsx';
import { Select } from '../components/ui/Select.tsx';
import { useLiveQueueStats, useWorkerLogs } from '../hooks/useSocket.ts';
import { api } from '../lib/api.ts';
import { cn } from '../lib/utils.ts';
import type { WorkerConfig } from '@secscan/shared';

function WorkerPanel({ type, paused, stats, pipeline, concurrency, onConcurrencyChange, onPause, onResume, onDrain }: {
  type: 'scanner' | 'exploit';
  paused: boolean;
  stats: { active: number; waiting: number; completed: number; failed: number };
  pipeline?: { inProgress: number; done: number; failed: number };
  concurrency: number;
  onConcurrencyChange: (n: number) => void;
  onPause: () => void;
  onResume: () => void;
  onDrain: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{type === 'scanner' ? 'Scanner Workers' : 'Exploit Workers'}</CardTitle>
        <Badge variant={paused ? 'warning' : 'success'}>{paused ? 'Paused' : 'Running'}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-4 gap-2 text-center">
          {(type === 'scanner' && pipeline
            ? [
                ['Queue active', stats.active],
                ['Queue waiting', stats.waiting],
                ['Scans running', pipeline.inProgress],
                ['Scans finished', pipeline.done],
              ]
            : [
                ['Active', stats.active],
                ['Waiting', stats.waiting],
                ['Finished', stats.completed],
                ['Failed', stats.failed],
              ]
          ).map(([label, val]) => (
            <div key={label as string}>
              <p className="text-xl font-bold">{val}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm">Concurrency</span>
            <span className="font-medium text-sm">{concurrency}</span>
          </div>
          <input
            type="range" min={1} max={20} value={concurrency}
            onChange={(e) => onConcurrencyChange(Number(e.target.value))}
            className="w-full h-2 bg-muted rounded-full appearance-none cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-xs text-muted-foreground mt-1"><span>1</span><span>20</span></div>
        </div>
        <div className="flex gap-2">
          {paused ? (
            <Button size="sm" onClick={onResume} className="flex-1"><Play className="w-3.5 h-3.5" /> Resume</Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onPause} className="flex-1"><Pause className="w-3.5 h-3.5" /> Pause</Button>
          )}
          <ConfirmDialog
            title={type === 'scanner' ? 'Drain scanner queues' : 'Drain exploit queue'}
            description={
              type === 'scanner'
                ? `Remove all waiting jobs from the scanner queue (${stats.waiting} waiting). Jobs already running are not stopped. Cleared work will not run unless re-queued.`
                : `Remove all ${stats.waiting} waiting job${stats.waiting === 1 ? '' : 's'} from the exploit generation queue. Jobs already running are not stopped. Cleared work will not run unless re-queued.`
            }
            confirmText="Drain queue"
            onConfirm={onDrain}
          >
            {(open) => (
              <Button size="sm" variant="secondary" onClick={open}>
                <Square className="w-3.5 h-3.5" /> Drain
              </Button>
            )}
          </ConfirmDialog>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Workers() {
  const qc = useQueryClient();
  const [logFilter, setLogFilter] = useState<'all' | 'debug' | 'info' | 'warn' | 'error'>('all');
  const [workerFilter, setWorkerFilter] = useState('all');
  const [logFullscreen, setLogFullscreen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const { lines: allLogs, historyLoaded, clearDisplay } = useWorkerLogs(500, 500);
  const liveQueueStats = useLiveQueueStats();

  const { data: queueData, refetch: refetchQueue } = useQuery({
    queryKey: ['worker-queue-stats'],
    queryFn: () => api.getWorkerQueueStats() as Promise<{
      stats: Array<{ name: string; waiting: number; active: number; completed: number; failed: number }>;
      paused: { scanner: boolean; exploit: boolean };
      pipeline?: { inProgress: number; done: number; failed: number };
    }>,
    refetchInterval: 5000,
  });

  const { data: config, refetch: refetchConfig } = useQuery({
    queryKey: ['worker-config'],
    queryFn: () => api.getWorkerConfig() as Promise<WorkerConfig>,
  });

  const [scannerConc, setScannerConc] = useState(3);
  const [exploitConc, setExploitConc] = useState(2);

  useEffect(() => {
    if (config) {
      setScannerConc(config.scannerConcurrency);
      setExploitConc(config.exploitConcurrency);
    }
  }, [config]);

  const updateConfig = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.updateWorkerConfig(data),
    onSuccess: () => refetchConfig(),
  });

  const scannerPause = useMutation({ mutationFn: () => api.scannerPause(), onSuccess: () => refetchQueue() });
  const scannerResume = useMutation({ mutationFn: () => api.scannerResume(), onSuccess: () => refetchQueue() });
  const scannerDrain = useMutation({ mutationFn: () => api.scannerDrain(), onSuccess: () => refetchQueue() });
  const exploitPause = useMutation({ mutationFn: () => api.exploitPause(), onSuccess: () => refetchQueue() });
  const exploitResume = useMutation({ mutationFn: () => api.exploitResume(), onSuccess: () => refetchQueue() });
  const exploitDrain = useMutation({ mutationFn: () => api.exploitDrain(), onSuccess: () => refetchQueue() });
  const resetAllQueues = useMutation({
    mutationFn: () => api.resetAllWorkerQueues(),
    onSuccess: () => {
      qc.setQueryData(['worker-queue-stats'], (prev: typeof queueData) =>
        prev
          ? {
              ...prev,
              stats: prev.stats.map((s) => ({ ...s, waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 })),
              pipeline: { inProgress: 0, done: 0, failed: 0 },
            }
          : prev,
      );
      refetchQueue();
    },
  });

  const stats = liveQueueStats.length > 0 ? liveQueueStats : queueData?.stats ?? [];
  const paused = queueData?.paused ?? { scanner: false, exploit: false };

  const scanStats = stats.find((s) => s.name === 'repo-scan-queue') ?? { active: 0, waiting: 0, completed: 0, failed: 0 };
  const exploitStats = stats.find((s) => s.name === 'exploit-gen-queue') ?? { active: 0, waiting: 0, completed: 0, failed: 0 };
  const pipeline = queueData?.pipeline;

  const filteredLogs = allLogs.filter((l) => {
    if (logFilter !== 'all' && l.level !== logFilter) return false;
    if (workerFilter !== 'all' && l.worker !== workerFilter) return false;
    return true;
  });

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [filteredLogs]);

  useEffect(() => {
    if (!logFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLogFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [logFullscreen]);

  const downloadLogs = async () => {
    const blob = await api.downloadWorkerLogs();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'workers.log';
    a.click();
  };

  const clearLogs = useMutation({
    mutationFn: () => api.clearWorkerLogs(),
    onSuccess: () => clearDisplay(),
  });

  return (
    <Layout title="Workers" subtitle="Control scan and exploit worker processes">
      <div className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <WorkerPanel
            type="scanner"
            paused={paused.scanner}
            stats={scanStats as { active: number; waiting: number; completed: number; failed: number }}
            pipeline={pipeline}
            concurrency={scannerConc}
            onConcurrencyChange={(n) => { setScannerConc(n); updateConfig.mutate({ scannerConcurrency: n }); }}
            onPause={() => scannerPause.mutate()}
            onResume={() => scannerResume.mutate()}
            onDrain={() => scannerDrain.mutate()}
          />
          <WorkerPanel
            type="exploit"
            paused={paused.exploit}
            stats={exploitStats as { active: number; waiting: number; completed: number; failed: number }}
            concurrency={exploitConc}
            onConcurrencyChange={(n) => { setExploitConc(n); updateConfig.mutate({ exploitConcurrency: n }); }}
            onPause={() => exploitPause.mutate()}
            onResume={() => exploitResume.mutate()}
            onDrain={() => exploitDrain.mutate()}
          />
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
              <CardTitle>Reset queue statistics</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Clear scanner and exploit Redis queues and delete scan job history so every counter on this page returns to zero.
              </p>
            </div>
            <ConfirmDialog
              title="Reset all queues"
              description={
                'This permanently clears both worker queues (waiting, active, completed, and failed counts) ' +
                'and deletes all scan job records so pipeline counters reset to zero. Repos stuck mid-scan are set back to queued. ' +
                'Vulnerabilities and secrets tied to deleted scan jobs are removed. Running worker jobs may error; restart workers if needed. This cannot be undone.'
              }
              confirmText="Reset all queues"
              requireTyped="RESET"
              onConfirm={async () => { await resetAllQueues.mutateAsync(); }}
            >
              {(open) => (
                <Button size="sm" variant="destructive" onClick={open} loading={resetAllQueues.isPending}>
                  <RotateCcw className="w-3.5 h-3.5" /> Reset queues
                </Button>
              )}
            </ConfirmDialog>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-muted-foreground" />
              <CardTitle>Exploit Auto-Queue</CardTitle>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Control whether findings are automatically queued for exploitation after a scan.
              When disabled, use the Vulnerabilities page to manually select and queue findings.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Auto-queue after scan</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  When off, scans save findings only — nothing is queued automatically.
                </p>
              </div>
              <button
                onClick={() => updateConfig.mutate({ autoQueueExploits: !config?.autoQueueExploits })}
                className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${config?.autoQueueExploits ? 'bg-primary' : 'bg-muted'}`}
                title={config?.autoQueueExploits ? 'Disable auto-queue' : 'Enable auto-queue'}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${config?.autoQueueExploits ? 'translate-x-5' : ''}`} />
              </button>
            </div>
            {config?.autoQueueExploits && (
              <>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Minimum severity</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Only queue findings at or above this severity.</p>
                  </div>
                  <Select
                    value={config.exploitMinSeverity}
                    onChange={(e) => updateConfig.mutate({ exploitMinSeverity: e.target.value })}
                    className="w-36"
                  >
                    {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </Select>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Include dropped findings</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Also queue findings that the scanner intentionally dropped.</p>
                  </div>
                  <button
                    onClick={() => updateConfig.mutate({ exploitIncludeDropped: !config?.exploitIncludeDropped })}
                    className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${config?.exploitIncludeDropped ? 'bg-primary' : 'bg-muted'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${config?.exploitIncludeDropped ? 'translate-x-5' : ''}`} />
                  </button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card
          className={cn(
            logFullscreen && 'fixed inset-0 z-50 flex flex-col rounded-none border-0 shadow-none h-screen',
          )}
        >
          <CardHeader className={cn('flex flex-row items-center justify-between', logFullscreen && 'flex-shrink-0')}>
            <div>
              <CardTitle>Log Stream</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {historyLoaded ? 'Last 500 lines from disk + live updates' : 'Loading history…'}
                {logFullscreen && ' · Esc to exit'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Select value={workerFilter} onChange={(e) => setWorkerFilter(e.target.value)} className="text-xs h-7">
                <option value="all">All workers</option>
                {['scanner', 'cve', 'exploit', 'api'].map((w) => <option key={w} value={w}>{w}</option>)}
              </Select>
              <Select value={logFilter} onChange={(e) => setLogFilter(e.target.value as typeof logFilter)} className="text-xs h-7">
                <option value="all">All levels</option>
                <option value="debug">DEBUG</option>
                <option value="info">INFO</option>
                <option value="warn">WARN</option>
                <option value="error">ERROR</option>
              </Select>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLogFullscreen((v) => !v)}
                title={logFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                {logFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </Button>
              <Button size="sm" variant="ghost" onClick={downloadLogs} title="Download logs"><Download className="w-3.5 h-3.5" /></Button>
              <Button size="sm" variant="ghost" onClick={() => clearLogs.mutate()} title="Clear log file"><Trash className="w-3.5 h-3.5" /></Button>
            </div>
          </CardHeader>
          <div
            ref={logRef}
            className={cn(
              'overflow-y-auto font-mono text-xs bg-gray-950 text-gray-100 p-3 space-y-0.5',
              logFullscreen ? 'flex-1 min-h-0' : 'h-80',
            )}
          >
            {!historyLoaded ? (
              <p className="text-gray-500">Loading log history…</p>
            ) : filteredLogs.length === 0 ? (
              <p className="text-gray-500">No log entries yet. Workers will stream here when active.</p>
            ) : (
              filteredLogs.map((line, i) => (
                <div key={i} className={cn('flex gap-2 leading-5', line.level === 'error' ? 'text-red-400' : line.level === 'warn' ? 'text-amber-400' : line.level === 'debug' ? 'text-purple-300' : 'text-gray-200')}>
                  <span className="text-gray-500 flex-shrink-0">{new Date(line.timestamp).toLocaleTimeString()}</span>
                  <span className={cn('flex-shrink-0 uppercase', line.level === 'error' ? 'text-red-400' : line.level === 'warn' ? 'text-amber-400' : line.level === 'debug' ? 'text-purple-400' : 'text-blue-400')}>{line.level}</span>
                  <span className="text-gray-400 flex-shrink-0">[{line.worker}]</span>
                  <span className="break-all">{line.message}</span>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </Layout>
  );
}
