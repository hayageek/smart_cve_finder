import { useState, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type ColumnDef, type RowSelectionState } from '@tanstack/react-table';
import { Trash2 } from 'lucide-react';
import { Layout } from '../../components/Layout.tsx';
import { DataTable, Pagination } from '../../components/ui/DataTable.tsx';
import { Button } from '../../components/ui/Button.tsx';
import { Input } from '../../components/ui/Input.tsx';
import { Select } from '../../components/ui/Select.tsx';
import { SeverityBadge, Badge } from '../../components/ui/Badge.tsx';
import { Modal, ConfirmDialog } from '../../components/ui/Dialog.tsx';
import { DeleteSameValueSecretsButton } from '../../components/DeleteSameValueSecretsButton.tsx';
import { api } from '../../lib/api.ts';
import { RepoUrlLink } from '../../components/RepoUrlLink.tsx';
import { formatDate, formatFileLine, truncate } from '../../lib/utils.ts';
import type { ApiSecret } from '@secscan/shared';

const VERIFY_STATUSES = ['verified', 'unverified', 'dead'] as const;
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

function VerifyBadge({ status }: { status: string }) {
  const variant = status === 'verified' ? 'default' : status === 'dead' ? 'secondary' : 'warning';
  return <Badge variant={variant}>{status}</Badge>;
}

function SecretDetail({ secret, onClose }: { secret: ApiSecret; onClose: () => void }) {
  const qc = useQueryClient();

  const fpMutation = useMutation({
    mutationFn: (val: boolean) => api.setSecretFalsePositive(secret.id, val),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['secrets'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteSecret(secret.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['secrets'] });
      onClose();
    },
  });

  return (
    <Modal open={true} title="Secret Detail" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <SeverityBadge severity={secret.severity} />
          <VerifyBadge status={secret.verifyStatus} />
          {secret.isFalsePositive && <Badge variant="secondary">False Positive</Badge>}
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Rule</p>
          <p className="font-mono text-xs">{secret.ruleId}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Location</p>
          <p className="font-mono text-xs">{formatFileLine(secret.path, secret.lineStart, secret.lineEnd)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Secret value</p>
          <p className="font-mono text-xs break-all select-all">{secret.redactedValue ?? '—'}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Repo</p>
          <RepoUrlLink repoUrl={secret.repoUrl} fullWidth className="text-sm" />
        </div>
        {secret.message && (
          <div>
            <p className="text-xs text-muted-foreground">Message</p>
            <p>{secret.message}</p>
          </div>
        )}
        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            size="sm"
            variant={secret.isFalsePositive ? 'secondary' : 'outline'}
            loading={fpMutation.isPending}
            onClick={() => fpMutation.mutate(!secret.isFalsePositive)}
          >
            {secret.isFalsePositive ? 'Unmark FP' : 'Mark False Positive'}
          </Button>
          {secret.redactedValue && (
            <DeleteSameValueSecretsButton
              value={secret.redactedValue}
              onDeleted={onClose}
            />
          )}
          <ConfirmDialog
            title="Delete this finding?"
            description="Permanently delete this secret finding only?"
            confirmText="Delete"
            onConfirm={async () => { await deleteMutation.mutateAsync(); }}
          >
            {(open) => (
              <Button size="sm" variant="outline" loading={deleteMutation.isPending} onClick={open}>
                Delete this one
              </Button>
            )}
          </ConfirmDialog>
        </div>
      </div>
    </Modal>
  );
}

export default function SecretsConfirmed() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [severity, setSeverity] = useState('');
  const [verifyStatus, setVerifyStatus] = useState('');
  const [ruleId, setRuleId] = useState('');
  const [fpFilter, setFpFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ApiSecret | null>(null);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const selectedIds = useMemo(
    () => Object.keys(rowSelection).filter((id) => rowSelection[id]),
    [rowSelection],
  );

  const { data, isLoading } = useQuery({
    queryKey: ['secrets', page, pageSize, severity, verifyStatus, ruleId, fpFilter, search],
    queryFn: () => api.getSecrets({
      page,
      pageSize,
      repoUrl: search,
      ...(severity ? { severity } : {}),
      ...(verifyStatus ? { verifyStatus } : {}),
      ...(ruleId ? { ruleId } : {}),
      ...(fpFilter ? { falsePositive: fpFilter } : {}),
    }),
    placeholderData: (prev) => prev,
  }) as { data: { data: ApiSecret[]; total: number; totalPages: number } | undefined; isLoading: boolean };

  const deleteBulk = useMutation({
    mutationFn: (ids: string[]) => api.deleteSecretsBulk(ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['secrets'] });
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
      accessorKey: 'severity',
      header: 'Severity',
      cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
    },
    {
      accessorKey: 'verifyStatus',
      header: 'Verified',
      cell: ({ row }) => <VerifyBadge status={row.original.verifyStatus} />,
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
        <span className="font-mono text-xs truncate max-w-[200px] block">
          {formatFileLine(row.original.path, row.original.lineStart, row.original.lineEnd)}
        </span>
      ),
    },
    {
      accessorKey: 'redactedValue',
      header: 'Secret value',
      cell: ({ row }) => {
        const v = row.original.redactedValue;
        return <span className="font-mono text-xs">{v ? truncate(v, 15) : '—'}</span>;
      },
    },
    {
      accessorKey: 'repoUrl',
      header: 'Repo',
      cell: ({ row }) => <RepoUrlLink repoUrl={row.original.repoUrl} />,
    },
    {
      accessorKey: 'createdAt',
      header: 'Found',
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{formatDate(row.original.createdAt)}</span>,
    },
  ], []);

  const handleRowClick = useCallback((row: ApiSecret) => setSelected(row), []);

  return (
    <Layout title="Secrets" subtitle="Confirmed secret findings">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2 items-end">
          <Input placeholder="Search repo…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="w-48" />
          <Select value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }} className="w-36">
            <option value="">All severities</option>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Select value={verifyStatus} onChange={(e) => { setVerifyStatus(e.target.value); setPage(1); }} className="w-36">
            <option value="">All verify</option>
            {VERIFY_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Input placeholder="Rule ID…" value={ruleId} onChange={(e) => { setRuleId(e.target.value); setPage(1); }} className="w-40" />
          <Select value={fpFilter} onChange={(e) => { setFpFilter(e.target.value); setPage(1); }} className="w-36">
            <option value="">All FP status</option>
            <option value="no">Not FP</option>
            <option value="yes">False positive</option>
          </Select>
          {selectedIds.length > 0 && (
            <ConfirmDialog
              title="Delete selected secrets?"
              description={`Permanently delete ${selectedIds.length} secret finding(s)?`}
              confirmText="Delete"
              onConfirm={async () => { await deleteBulk.mutateAsync(selectedIds); }}
            >
              {(open) => (
                <Button variant="destructive" size="sm" onClick={open} loading={deleteBulk.isPending}>
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

      {selected && <SecretDetail secret={selected} onClose={() => setSelected(null)} />}
    </Layout>
  );
}
