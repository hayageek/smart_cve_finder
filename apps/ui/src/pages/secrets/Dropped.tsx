import { useState, useCallback, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type ColumnDef, type RowSelectionState } from '@tanstack/react-table';
import { Trash2 } from 'lucide-react';
import { Layout } from '../../components/Layout.tsx';
import { DataTable, Pagination } from '../../components/ui/DataTable.tsx';
import { Button } from '../../components/ui/Button.tsx';
import { Input } from '../../components/ui/Input.tsx';
import { Select } from '../../components/ui/Select.tsx';
import { Badge, SeverityBadge } from '../../components/ui/Badge.tsx';
import { ConfirmDialog } from '../../components/ui/Dialog.tsx';
import { DeleteAllSecretsButton } from '../../components/DeleteAllSecretsButton.tsx';
import { DroppedSecretDetail } from '../../components/DroppedSecretDetail.tsx';
import { api } from '../../lib/api.ts';
import { RepoUrlLink } from '../../components/RepoUrlLink.tsx';
import { formatDate, formatFileLine, formatFileLineBasename } from '../../lib/utils.ts';
import type { ApiSecret } from '@secscan/shared';

const DROP_REASONS = [
  'commented',
  'trufflehog-dead',
  'example-or-doc',
  'test-fixture',
  'env-reference',
  'placeholder',
  'low-confidence',
  'uncertain',
];
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

export default function SecretsDropped() {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [dropReason, setDropReason] = useState('');
  const [severity, setSeverity] = useState('');
  const [ruleId, setRuleId] = useState(() => searchParams.get('ruleId') ?? '');

  useEffect(() => {
    setRuleId(searchParams.get('ruleId') ?? '');
    setPage(1);
  }, [searchParams]);
  const [repoSearch, setRepoSearch] = useState('');
  const [valueSearch, setValueSearch] = useState('');
  const [pathSearch, setPathSearch] = useState('');
  const [selected, setSelected] = useState<ApiSecret | null>(null);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const selectedIds = useMemo(
    () => Object.keys(rowSelection).filter((id) => rowSelection[id]),
    [rowSelection],
  );

  const { data, isLoading } = useQuery({
    queryKey: ['dropped-secrets', page, pageSize, dropReason, severity, ruleId, repoSearch, valueSearch, pathSearch],
    queryFn: () => api.getDroppedSecrets({
      page,
      pageSize,
      dropReason,
      ...(repoSearch ? { repoUrl: repoSearch } : {}),
      ...(valueSearch ? { value: valueSearch } : {}),
      ...(pathSearch ? { path: pathSearch } : {}),
      ...(severity ? { severity } : {}),
      ...(ruleId ? { ruleId } : {}),
    }),
    placeholderData: (prev) => prev,
  }) as { data: { data: ApiSecret[]; total: number; totalPages: number } | undefined; isLoading: boolean };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['dropped-secrets'] });
    qc.invalidateQueries({ queryKey: ['secrets'] });
  };

  const promote = useMutation({
    mutationFn: (id: string) => api.promoteDroppedSecret(id),
    onSuccess: invalidate,
  });

  const deleteSelected = useMutation({
    mutationFn: (ids: string[]) => api.deleteDroppedSecrets(ids),
    onSuccess: () => {
      invalidate();
      setRowSelection({});
      setSelected(null);
    },
  });

  const columns = useMemo<ColumnDef<ApiSecret>[]>(() => [
    {
      id: 'select',
      header: ({ table }) => (
        <input
          type="checkbox"
          checked={table.getIsAllPageRowsSelected()}
          ref={(el) => { if (el) el.indeterminate = table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected(); }}
          onChange={table.getToggleAllPageRowsSelectedHandler()}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 cursor-pointer accent-primary"
          title="Select all on this page"
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          checked={row.getIsSelected()}
          onChange={row.getToggleSelectedHandler()}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 cursor-pointer accent-primary"
        />
      ),
    },
    {
      accessorKey: 'dropReason',
      header: 'Drop reason',
      cell: ({ row }) => <Badge variant="outline">{row.original.dropReason ?? '—'}</Badge>,
    },
    {
      accessorKey: 'severity',
      header: 'Severity',
      cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
    },
    {
      accessorKey: 'ruleId',
      header: 'Rule',
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.ruleId}</span>,
    },
    {
      accessorKey: 'path',
      header: 'Location',
      cell: ({ row }) => (
        <span
          className="font-mono text-xs truncate max-w-[180px] block"
          title={formatFileLine(row.original.path, row.original.lineStart, row.original.lineEnd)}
        >
          {formatFileLineBasename(row.original.path, row.original.lineStart, row.original.lineEnd)}
        </span>
      ),
    },
    {
      accessorKey: 'repoUrl',
      header: 'Repo',
      cell: ({ row }) => <RepoUrlLink repoUrl={row.original.repoUrl} />,
    },
    {
      accessorKey: 'createdAt',
      header: 'Dropped',
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{formatDate(row.original.createdAt)}</span>,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          loading={promote.isPending}
          onClick={(e) => { e.stopPropagation(); promote.mutate(row.original.id); }}
        >
          Promote
        </Button>
      ),
    },
  ], [promote.isPending]);

  const handleRowClick = useCallback((row: ApiSecret) => setSelected(row), []);

  return (
    <Layout
      title="Dropped Secrets"
      subtitle="False positives and inactive credentials"
      actions={
        <DeleteAllSecretsButton
          scope="dropped"
          onDeleted={() => {
            setRowSelection({});
            setSelected(null);
          }}
        />
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2 items-end">
          <Input placeholder="Search repo…" value={repoSearch} onChange={(e) => { setRepoSearch(e.target.value); setPage(1); }} className="w-48" />
          <Input placeholder="Search value…" value={valueSearch} onChange={(e) => { setValueSearch(e.target.value); setPage(1); }} className="w-48" />
          <Input placeholder="Search location…" value={pathSearch} onChange={(e) => { setPathSearch(e.target.value); setPage(1); }} className="w-48" />
          <Select value={dropReason} onChange={(e) => { setDropReason(e.target.value); setPage(1); }} className="w-44">
            <option value="">All drop reasons</option>
            {DROP_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
          <Select value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }} className="w-36">
            <option value="">All severities</option>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Input placeholder="Rule ID…" value={ruleId} onChange={(e) => { setRuleId(e.target.value); setPage(1); }} className="w-40" />
          {selectedIds.length > 0 && (
            <ConfirmDialog
              title="Delete dropped secrets?"
              description={`Permanently delete ${selectedIds.length} dropped secret(s)?`}
              confirmText="Delete"
              onConfirm={async () => { await deleteSelected.mutateAsync(selectedIds); }}
            >
              {(open) => (
                <Button variant="destructive" size="sm" onClick={open} loading={deleteSelected.isPending}>
                  <Trash2 className="w-3.5 h-3.5" /> Delete ({selectedIds.length})
                </Button>
              )}
            </ConfirmDialog>
          )}
        </div>

        {isLoading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            <DataTable
              columns={columns}
              data={data?.data ?? []}
              onRowClick={handleRowClick}
              rowSelection={rowSelection}
              onRowSelectionChange={setRowSelection}
              getRowId={(row) => row.id}
            />

            <Pagination
              page={page}
              pageSize={pageSize}
              total={data?.total ?? 0}
              totalPages={data?.totalPages ?? 1}
              onPage={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
              pageSizeOptions={[...PAGE_SIZE_OPTIONS]}
            />
          </>
        )}
      </div>

      {selected && (
        <DroppedSecretDetail
          secret={selected}
          onClose={() => setSelected(null)}
          onPromote={() => promote.mutate(selected.id)}
          promoteLoading={promote.isPending}
        />
      )}
    </Layout>
  );
}
