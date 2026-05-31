import { useState, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type ColumnDef, type RowSelectionState } from '@tanstack/react-table';
import { Trash2, X } from 'lucide-react';
import { Layout } from '../../components/Layout.tsx';
import { DataTable, Pagination } from '../../components/ui/DataTable.tsx';
import { Button } from '../../components/ui/Button.tsx';
import { Input } from '../../components/ui/Input.tsx';
import { Select } from '../../components/ui/Select.tsx';
import { Badge, SeverityBadge } from '../../components/ui/Badge.tsx';
import { ConfirmDialog } from '../../components/ui/Dialog.tsx';
import { DroppedVulnDetail } from '../../components/DroppedVulnDetail.tsx';
import { api } from '../../lib/api.ts';
import { RepoUrlLink } from '../../components/RepoUrlLink.tsx';
import { formatDate, formatFileLine, formatVulnIdShort } from '../../lib/utils.ts';
import type { ApiVulnerability } from '@secscan/shared';

const DROP_REASONS = ['severity-below-high', 'excluded-path', 'false-positive-heuristic', 'low-confidence'];
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;

export default function Dropped() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [dropReason, setDropReason] = useState('');
  const [cwe, setCwe] = useState('');
  const [vulnType, setVulnType] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ApiVulnerability | null>(null);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const selectedIds = useMemo(
    () => Object.keys(rowSelection).filter((id) => rowSelection[id]),
    [rowSelection],
  );
  const selectedCount = selectedIds.length;

  const handleRowClick = useCallback((row: ApiVulnerability) => {
    setSelected(row);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ['dropped-vulns', page, pageSize, dropReason, cwe, vulnType, search],
    queryFn: () => api.getDroppedVulns({
      page,
      pageSize,
      dropReason,
      repoUrl: search,
      ...(cwe ? { cwe } : {}),
      ...(vulnType ? { vulnType } : {}),
    }),
    placeholderData: (prev) => prev,
  }) as { data: { data: ApiVulnerability[]; total: number; totalPages: number } | undefined; isLoading: boolean };

  const invalidateDropped = () => {
    qc.invalidateQueries({ queryKey: ['dropped-vulns'] });
    qc.invalidateQueries({ queryKey: ['vulns'] });
  };

  const promote = useMutation({
    mutationFn: (id: string) => api.promoteDropped(id),
    onSuccess: invalidateDropped,
  });

  const deleteOne = useMutation({
    mutationFn: (id: string) => api.deleteVulnerability(id),
    onSuccess: () => {
      invalidateDropped();
      setSelected(null);
    },
  });

  const deleteSelected = useMutation({
    mutationFn: (ids: string[]) => api.deleteDroppedVulns(ids),
    onSuccess: () => {
      invalidateDropped();
      setRowSelection({});
      setSelected(null);
    },
  });

  const clearAll = useMutation({
    mutationFn: () => api.clearDroppedVulns(),
    onSuccess: () => {
      invalidateDropped();
      setRowSelection({});
      setSelected(null);
    },
  });

  const columns: ColumnDef<ApiVulnerability, unknown>[] = [
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
    { header: 'Vuln ID', cell: ({ row }) => (
      <span className="font-mono text-xs" title={row.original.id}>{formatVulnIdShort(row.original.id)}</span>
    ) },
    { header: 'Repo / Package', cell: ({ row }) => (
      <RepoUrlLink repoUrl={row.original.repoUrl} display="table" />
    ) },
    { header: 'CWE', cell: ({ row }) => <span className="font-mono text-xs">{row.original.cwe}</span> },
    { header: 'Severity', cell: ({ row }) => <SeverityBadge severity={row.original.severity} /> },
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
    { header: 'Found', cell: ({ row }) => <span className="text-xs text-muted-foreground">{formatDate(row.original.createdAt)}</span> },
    {
      header: 'Status',
      cell: () => <Badge variant="outline">Dropped</Badge>,
    },
    {
      header: 'Actions',
      cell: ({ row }) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            variant="outline"
            loading={promote.isPending}
            onClick={() => promote.mutate(row.original.id)}
          >
            Promote
          </Button>
          <ConfirmDialog
            title="Delete Dropped Finding"
            description="Permanently remove this dropped finding?"
            confirmText="Delete"
            onConfirm={async () => { await deleteOne.mutateAsync(row.original.id); }}
          >
            {(open) => (
              <Button
                size="sm"
                variant="destructive"
                loading={deleteOne.isPending}
                onClick={open}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
          </ConfirmDialog>
        </div>
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
          <Input placeholder="Filter by CWE..." value={cwe} onChange={(e) => { setCwe(e.target.value); setPage(1); }} className="max-w-[140px]" />
          <Input placeholder="Filter by type..." value={vulnType} onChange={(e) => { setVulnType(e.target.value); setPage(1); }} className="max-w-[160px]" />
          <Select value={dropReason} onChange={(e) => { setDropReason(e.target.value); setPage(1); }}>
            <option value="">All reasons</option>
            {DROP_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </div>

        {selectedCount > 0 && (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-4 py-2.5">
            <span className="text-sm font-medium text-foreground">
              {selectedCount} {selectedCount === 1 ? 'finding' : 'findings'} selected
            </span>
            <div className="flex items-center gap-2 ml-auto">
              <ConfirmDialog
                title="Delete Selected Findings"
                description={`Permanently delete ${selectedCount} dropped ${selectedCount === 1 ? 'finding' : 'findings'}?`}
                confirmText="Delete"
                onConfirm={async () => { await deleteSelected.mutateAsync(selectedIds); }}
              >
                {(open) => (
                  <Button
                    size="sm"
                    variant="destructive"
                    loading={deleteSelected.isPending}
                    onClick={open}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Selected
                  </Button>
                )}
              </ConfirmDialog>
              <button
                onClick={() => setRowSelection({})}
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                title="Clear selection"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" /></div>
        ) : (
          <>
            <DataTable
              data={data?.data ?? []}
              columns={columns}
              onRowClick={handleRowClick}
              rowSelection={rowSelection}
              onRowSelectionChange={setRowSelection}
              getRowId={(row) => row.id}
            />
            <Pagination
              page={page}
              totalPages={data?.totalPages ?? 1}
              onPage={setPage}
              total={data?.total ?? 0}
              pageSize={pageSize}
              pageSizeOptions={[...PAGE_SIZE_OPTIONS]}
              onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
            />
          </>
        )}
      </div>
      {selected && (
        <DroppedVulnDetail
          vuln={selected}
          onClose={() => setSelected(null)}
          onPromote={() => promote.mutate(selected.id, { onSuccess: () => setSelected(null) })}
          promoteLoading={promote.isPending}
          onDelete={async () => { await deleteOne.mutateAsync(selected.id); }}
          deleteLoading={deleteOne.isPending}
        />
      )}
    </Layout>
  );
}
