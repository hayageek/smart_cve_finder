import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type ColumnDef } from '@tanstack/react-table';
import { Layout } from '../../components/Layout.tsx';
import { DataTable, Pagination } from '../../components/ui/DataTable.tsx';
import { Button } from '../../components/ui/Button.tsx';
import { Input } from '../../components/ui/Input.tsx';
import { Select } from '../../components/ui/Select.tsx';
import { Badge } from '../../components/ui/Badge.tsx';
import { ConfirmDialog } from '../../components/ui/Dialog.tsx';
import { api } from '../../lib/api.ts';
import { RepoUrlLink } from '../../components/RepoUrlLink.tsx';
import { formatDate, formatFileLine } from '../../lib/utils.ts';
import type { ApiVulnerability } from '@secscan/shared';

const DROP_REASONS = ['severity-below-high', 'excluded-path', 'false-positive-heuristic', 'low-confidence'];

export default function Dropped() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [dropReason, setDropReason] = useState('');
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['dropped-vulns', page, dropReason, search],
    queryFn: () => api.getDroppedVulns({ page, pageSize: 20, dropReason, repoUrl: search }),
    placeholderData: (prev) => prev,
  }) as { data: { data: ApiVulnerability[]; total: number; totalPages: number } | undefined; isLoading: boolean };

  const promote = useMutation({
    mutationFn: (id: string) => api.promoteDropped(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dropped-vulns'] }); qc.invalidateQueries({ queryKey: ['vulns'] }); },
  });

  const clearAll = useMutation({
    mutationFn: () => api.clearDroppedVulns(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dropped-vulns'] }),
  });

  const columns: ColumnDef<ApiVulnerability, unknown>[] = [
    { header: 'Vuln ID', cell: ({ row }) => (
      <span className="font-mono text-xs" title={row.original.id}>{row.original.id}</span>
    ) },
    { header: 'CWE', cell: ({ row }) => <span className="font-mono text-xs">{row.original.cwe}</span> },
    { header: 'File:Line', cell: ({ row }) => (
      <span
        className="font-mono text-xs block max-w-md truncate"
        title={`${row.original.path}:${row.original.lineStart}`}
      >
        {formatFileLine(row.original.path, row.original.lineStart, row.original.lineEnd)}
      </span>
    ) },
    { header: 'Drop Reason', cell: ({ row }) => <Badge variant="secondary">{row.original.dropReason}</Badge> },
    { header: 'Evidence', cell: ({ row }) => <span className="text-xs text-muted-foreground max-w-48 truncate block">{row.original.dropEvidence}</span> },
    { header: 'Repo', cell: ({ row }) => <RepoUrlLink repoUrl={row.original.repoUrl} /> },
    { header: 'Found', cell: ({ row }) => <span className="text-xs text-muted-foreground">{formatDate(row.original.createdAt)}</span> },
    {
      header: 'Status',
      cell: () => <Badge variant="outline">Dropped</Badge>,
    },
    {
      header: 'Action',
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="outline"
          loading={promote.isPending}
          onClick={(e) => { e.stopPropagation(); promote.mutate(row.original.id); }}
        >
          Promote
        </Button>
      ),
    },
  ];

  return (
    <Layout
      title="Dropped Vulnerabilities"
      subtitle={`${data?.total ?? 0} suppressed findings`}
      actions={
        <ConfirmDialog
          title="Clear Dropped Vulnerabilities"
          description="Remove all dropped vulnerability records?"
          requireTyped="clear"
          onConfirm={() => clearAll.mutate()}
        >
          {(open) => <Button variant="destructive" size="sm" onClick={open}>Clear All</Button>}
        </ConfirmDialog>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2 flex-wrap">
          <Input placeholder="Filter by repo..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="max-w-xs" />
          <Select value={dropReason} onChange={(e) => { setDropReason(e.target.value); setPage(1); }}>
            <option value="">All reasons</option>
            {DROP_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </div>
        {isLoading ? (
          <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" /></div>
        ) : (
          <>
            <DataTable data={data?.data ?? []} columns={columns} />
            <Pagination page={page} totalPages={data?.totalPages ?? 1} onPage={setPage} total={data?.total ?? 0} pageSize={20} />
          </>
        )}
      </div>
    </Layout>
  );
}
