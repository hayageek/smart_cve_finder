import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type ColumnDef } from '@tanstack/react-table';
import { Layout } from '../../components/Layout.tsx';
import { DataTable, Pagination } from '../../components/ui/DataTable.tsx';
import { Input } from '../../components/ui/Input.tsx';
import { Select } from '../../components/ui/Select.tsx';
import { StatusBadge } from '../../components/ui/Badge.tsx';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/Card.tsx';
import { api } from '../../lib/api.ts';
import { formatDate, formatDuration, repoShortName } from '../../lib/utils.ts';

interface ScanJob {
  id: string; repoUrl: string; provider: string; status: string;
  startedAt: string | null; finishedAt: string | null; durationMs: number | null;
  error: string | null; createdAt: string; vulnCount: number; exploitCount: number;
}

export default function ScanHistory() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<ScanJob | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['scan-history', page, search, status],
    queryFn: () => api.getScanHistory({ page, pageSize: 20, repoUrl: search, status }),
    placeholderData: (prev) => prev,
  }) as { data: { data: ScanJob[]; total: number; totalPages: number } | undefined; isLoading: boolean };

  const columns: ColumnDef<ScanJob, unknown>[] = [
    {
      header: 'Repository',
      cell: ({ row }) => <span className="font-mono text-xs">{repoShortName(row.original.repoUrl)}</span>,
    },
    { header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    { header: 'Started', cell: ({ row }) => <span className="text-xs text-muted-foreground">{formatDate(row.original.startedAt)}</span> },
    { header: 'Duration', cell: ({ row }) => <span className="text-xs">{formatDuration(row.original.durationMs)}</span> },
    { header: 'Vulns', cell: ({ row }) => <span className="font-medium">{row.original.vulnCount}</span> },
    { header: 'Exploits', cell: ({ row }) => <span>{row.original.exploitCount}</span> },
  ];

  return (
    <Layout title="Scan History" subtitle={`${data?.total ?? 0} total scans`}>
      <div className="flex gap-6">
        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex gap-2">
            <Input placeholder="Filter by repo URL..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="max-w-xs" />
            <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All statuses</option>
              {['done', 'failed', 'scanning', 'exploiting', 'cloning', 'pending', 'skipped'].map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
          {isLoading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" /></div>
          ) : (
            <>
              <DataTable data={data?.data ?? []} columns={columns} onRowClick={setSelected} />
              <Pagination page={page} totalPages={data?.totalPages ?? 1} onPage={setPage} total={data?.total ?? 0} pageSize={20} />
            </>
          )}
        </div>

        {selected && (
          <div className="w-72 flex-shrink-0">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Scan Detail</CardTitle>
                <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Repository</p>
                  <p className="font-mono text-xs break-all">{selected.repoUrl}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <StatusBadge status={selected.status} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div><p className="text-xs text-muted-foreground">Started</p><p className="text-xs">{formatDate(selected.startedAt)}</p></div>
                  <div><p className="text-xs text-muted-foreground">Finished</p><p className="text-xs">{formatDate(selected.finishedAt)}</p></div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Duration</p>
                  <p className="font-medium">{formatDuration(selected.durationMs)}</p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div><p className="text-xs text-muted-foreground">Vulns Found</p><p className="font-medium">{selected.vulnCount}</p></div>
                  <div><p className="text-xs text-muted-foreground">Exploits</p><p className="font-medium">{selected.exploitCount}</p></div>
                </div>
                {selected.error && (
                  <div>
                    <p className="text-xs text-muted-foreground">Error</p>
                    <p className="text-xs text-destructive break-all">{selected.error}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </Layout>
  );
}
