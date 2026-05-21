import { useQuery } from '@tanstack/react-query';
import { Layout } from '../components/Layout.tsx';
import { StatCard, Card, CardHeader, CardTitle, CardContent } from '../components/ui/Card.tsx';
import { Badge } from '../components/ui/Badge.tsx';
import { api } from '../lib/api.ts';
import { useActivityFeed, useLiveQueueStats } from '../hooks/useSocket.ts';
import { formatRelative } from '../lib/utils.ts';

export default function Dashboard() {
  const { data } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => api.getDashboardStats() as Promise<Record<string, Record<string, number>>>,
    refetchInterval: 15000,
  });
  const liveQueueStats = useLiveQueueStats();
  const activity = useActivityFeed();

  const stats = data as {
    repos?: Record<string, number>;
    scans?: Record<string, number>;
    vulns?: Record<string, number>;
    exploits?: Record<string, number>;
    queues?: Array<{ name: string; waiting: number; active: number; completed: number; failed: number; delayed: number }>;
  } | undefined;

  const queues = liveQueueStats.length > 0 ? liveQueueStats : stats?.queues ?? [];

  return (
    <Layout title="Dashboard" subtitle="System-wide scan status and activity">
      <div className="space-y-6">
        {/* Repository stats */}
        <section>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Repositories</h2>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="Total" value={stats?.repos?.total ?? 0} accent />
            <StatCard label="Queued" value={stats?.repos?.queued ?? 0} />
            <StatCard label="Scanning" value={stats?.repos?.scanning ?? 0} />
            <StatCard label="Completed" value={stats?.repos?.done ?? 0} />
            <StatCard label="Failed" value={stats?.repos?.failed ?? 0} />
          </div>
        </section>

        {/* Queue depth */}
        <section>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Queue Depth</h2>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {queues.map((q) => (
              <Card key={q.name}>
                <CardHeader><CardTitle className="font-mono text-xs">{q.name}</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid grid-cols-5 gap-1 text-center">
                    {(['waiting', 'active', 'completed', 'failed', 'delayed'] as const).map((k) => (
                      <div key={k}>
                        <p className="text-lg font-bold">{(q as unknown as Record<string, number>)[k] ?? 0}</p>
                        <p className="text-xs text-muted-foreground capitalize">{k}</p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Scan outcomes */}
          <section>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Scan Outcomes</h2>
            <div className="grid grid-cols-2 gap-3">
              <StatCard label="Success" value={stats?.scans?.success ?? 0} />
              <StatCard label="Failed" value={stats?.scans?.failed ?? 0} />
            </div>
          </section>

          {/* Vulnerability summary */}
          <section>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Vulnerabilities</h2>
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Critical" value={stats?.vulns?.critical ?? 0} />
              <StatCard label="High" value={stats?.vulns?.high ?? 0} />
              <StatCard label="Medium" value={stats?.vulns?.medium ?? 0} />
              <StatCard label="Low" value={stats?.vulns?.low ?? 0} />
              <StatCard label="Dropped" value={stats?.vulns?.dropped ?? 0} />
              <StatCard label="FP" value={stats?.vulns?.falsePositives ?? 0} />
            </div>
          </section>

          {/* Exploit summary */}
          <section>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Exploits</h2>
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Generated" value={stats?.exploits?.generated ?? 0} />
              <StatCard label="Pending" value={stats?.exploits?.pending ?? 0} />
              <StatCard label="Failed" value={stats?.exploits?.failed ?? 0} />
            </div>
          </section>
        </div>

        {/* Activity feed */}
        <section>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Recent Activity</h2>
          <Card>
            <CardContent className="p-0">
              {activity.length === 0 ? (
                <p className="text-sm text-muted-foreground p-4">No recent activity. Upload a CSV to start scanning.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {activity.slice(0, 30).map((evt) => (
                    <li key={evt.id} className="px-4 py-2.5 flex items-start gap-3">
                      <span className="text-xs text-muted-foreground whitespace-nowrap mt-0.5">{formatRelative(evt.timestamp)}</span>
                      <Badge variant={evt.type === 'error' ? 'destructive' : evt.type === 'scan' ? 'warning' : 'secondary'}>
                        {evt.type}
                      </Badge>
                      <span className="text-sm flex-1">{evt.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </Layout>
  );
}
