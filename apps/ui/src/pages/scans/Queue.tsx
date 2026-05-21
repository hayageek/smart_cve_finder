import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Layout } from '../../components/Layout.tsx';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/Card.tsx';
import { Button } from '../../components/ui/Button.tsx';
import { Badge } from '../../components/ui/Badge.tsx';
import { useLiveQueueStats, useLiveJobProgress } from '../../hooks/useSocket.ts';
import { api } from '../../lib/api.ts';
import { cn } from '../../lib/utils.ts';
import { RefreshCw, AlertCircle } from 'lucide-react';

function QueueCard({ name, stats }: { name: string; stats: Record<string, number> }) {
  const labels: Array<{ key: string; label: string }> = [
    { key: 'waiting', label: 'waiting' },
    { key: 'active', label: 'active' },
    { key: 'completed', label: 'subtasks done' },
    { key: 'failed', label: 'failed' },
    { key: 'delayed', label: 'delayed' },
  ];
  return (
    <Card>
      <CardHeader><CardTitle className="font-mono text-xs">{name}</CardTitle></CardHeader>
      <CardContent>
        <div className="grid grid-cols-5 gap-1 text-center">
          {labels.map(({ key, label }) => (
            <div key={key}>
              <p className={cn('text-xl font-bold', key === 'failed' && stats[key] > 0 ? 'text-destructive' : '', key === 'active' && stats[key] > 0 ? 'text-amber-600' : '')}>{stats[key] ?? 0}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
        <div className="mt-3">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${Math.min(100, ((stats.active ?? 0) / Math.max(1, (stats.active ?? 0) + (stats.waiting ?? 0))) * 100)}%` }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function JobProgressCard({ job }: { job: { repoUrl: string; stage: string; progress: number; status: string; jobId: string } }) {
  const stages = ['clone', 'cve-scan', 'exploit-gen'];
  const currentIdx = stages.indexOf(job.stage);
  return (
    <Card className="flex-1 min-w-0">
      <CardContent className="py-3">
        <p className="font-mono text-xs text-primary truncate mb-2">{job.repoUrl}</p>
        <div className="flex items-center gap-2 mb-2">
          {stages.map((s, i) => (
            <div key={s} className="flex items-center gap-1">
              <div className={cn(
                'w-5 h-5 rounded-full flex items-center justify-center text-xs',
                i < currentIdx ? 'bg-emerald-100 text-emerald-700' :
                i === currentIdx ? 'bg-amber-100 text-amber-700 animate-pulse' :
                'bg-muted text-muted-foreground',
              )}>
                {i < currentIdx ? '✓' : i + 1}
              </div>
              <span className="text-xs text-muted-foreground capitalize">{s.replace('-', ' ')}</span>
              {i < stages.length - 1 && <span className="text-muted-foreground mx-1">→</span>}
            </div>
          ))}
        </div>
        <div className="h-1 bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${job.progress}%` }} />
        </div>
        <p className="text-xs text-muted-foreground mt-1">{job.progress}%</p>
      </CardContent>
    </Card>
  );
}

export default function ScanQueue() {
  const qc = useQueryClient();
  const liveStats = useLiveQueueStats();
  const liveJobs = useLiveJobProgress();

  const { data: queueData } = useQuery({
    queryKey: ['worker-queue-stats'],
    queryFn: () => api.getWorkerQueueStats() as Promise<{ stats: Array<{ name: string; waiting: number; active: number; completed: number; failed: number; delayed: number }>; paused: { scanner: boolean; exploit: boolean } }>,
    refetchInterval: 8000,
  });

  const { data: failedData } = useQuery({
    queryKey: ['failed-jobs'],
    queryFn: () => api.getFailedJobs() as Promise<Record<string, Array<{ id: string; name: string; data: unknown; failedReason?: string }>>>,
    refetchInterval: 15000,
  });

  const clearFailed = useMutation({
    mutationFn: () => api.clearFailedJobs(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['failed-jobs'] }),
  });

  const stats = liveStats.length > 0 ? liveStats : queueData?.stats ?? [];

  const allFailed = [
    ...(failedData?.scan ?? []).map((j) => ({ ...j, queue: 'repo-scan-queue' })),
    ...(failedData?.cve ?? []).map((j) => ({ ...j, queue: 'cve-scan-queue' })),
    ...(failedData?.exploit ?? []).map((j) => ({ ...j, queue: 'exploit-gen-queue' })),
  ];

  return (
    <Layout title="Scan Queue" subtitle="Live view of in-flight scan work">
      <div className="space-y-6">
        <section>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Queue Counters</h2>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {stats.map((q) => (
              <QueueCard key={q.name} name={q.name} stats={q as unknown as Record<string, number>} />
            ))}
          </div>
        </section>

        {liveJobs.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Active Jobs ({liveJobs.length})</h2>
            <div className="flex flex-col gap-2">
              {liveJobs.map((job) => <JobProgressCard key={job.jobId} job={job} />)}
            </div>
          </section>
        )}

        {allFailed.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Failed Jobs ({allFailed.length})</h2>
              <Button size="sm" variant="outline" loading={clearFailed.isPending} onClick={() => clearFailed.mutate()}>
                Clear Failed
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              {allFailed.map((job) => (
                <Card key={`${job.queue}-${job.id}`}>
                  <CardContent className="py-3 flex items-start gap-3">
                    <AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-muted-foreground">{job.queue} · #{job.id}</p>
                      <p className="text-sm text-destructive mt-0.5">{(job as { failedReason?: string }).failedReason ?? 'Unknown error'}</p>
                    </div>
                    <Badge variant="destructive">failed</Badge>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}
      </div>
    </Layout>
  );
}
