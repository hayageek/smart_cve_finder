import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Trash2, ExternalLink, Lock, Globe, Package, CheckCircle, AlertCircle } from 'lucide-react';
import { type ColumnDef, type RowSelectionState } from '@tanstack/react-table';
import { Layout } from '../../components/Layout.tsx';
import { DataTable, Pagination } from '../../components/ui/DataTable.tsx';
import { Button } from '../../components/ui/Button.tsx';
import { Input } from '../../components/ui/Input.tsx';
import { Select } from '../../components/ui/Select.tsx';
import { Badge, StatusBadge } from '../../components/ui/Badge.tsx';
import { ConfirmDialog } from '../../components/ui/Dialog.tsx';
import { api } from '../../lib/api.ts';
import { formatRelative, cn } from '../../lib/utils.ts';

type ScanMode = 'both' | 'cve' | 'secrets';

const SCAN_MODES: { value: ScanMode; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'cve', label: 'CVE Hunt' },
  { value: 'secrets', label: 'Secrets' },
];

interface Repo {
  id: string;
  url: string;
  repoUrl: string | null;
  packageName: string | null;
  packageType: string;
  packageVersion: string | null;
  provider: string;
  isPrivate: boolean;
  status: string;
  lastScannedAt: string | null;
  createdAt: string;
  vulnCount: number;
  exploitCount: number;
}

const PKG_PILL: Record<string, string> = {
  npm: 'text-red-700 bg-red-50 border-red-200',
  pip: 'text-blue-700 bg-blue-50 border-blue-200',
  cargo: 'text-orange-700 bg-orange-50 border-orange-200',
  go: 'text-cyan-700 bg-cyan-50 border-cyan-200',
  gem: 'text-rose-700 bg-rose-50 border-rose-200',
};

const IN_SCAN_STATUSES = new Set(['cloning', 'scanning', 'exploiting']);

function SourceCell({ repo }: { repo: Repo }) {
  const isPackage = repo.packageType !== 'git';
  const linkUrl = isPackage ? (repo.repoUrl ?? null) : repo.url;

  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5">
        {isPackage ? (
          <span className={cn('flex items-center gap-1 text-xs border rounded px-1 py-0.5 font-medium', PKG_PILL[repo.packageType])}>
            <Package className="w-3 h-3" /> {repo.packageType.toUpperCase()}
          </span>
        ) : (
          <Badge variant={repo.provider === 'github' ? 'default' : repo.provider === 'bitbucket' ? 'secondary' : 'outline'} className="text-xs">
            {repo.provider}
          </Badge>
        )}
        <span className="font-mono text-xs font-medium truncate max-w-[220px]">
          {isPackage ? repo.packageName : repo.url.replace(/^https?:\/\//, '')}
          {repo.packageVersion && <span className="text-muted-foreground">@{repo.packageVersion}</span>}
        </span>
      </div>
      {isPackage && linkUrl && (
        <a
          href={linkUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-primary truncate max-w-[260px]"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
          {linkUrl.replace(/^https?:\/\//, '')}
        </a>
      )}
      {!isPackage && (
        <a
          href={repo.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-primary"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="w-2.5 h-2.5" /> Open
        </a>
      )}
    </div>
  );
}

function VisibilityToggle({ repo, onToggle }: { repo: Repo; onToggle: (id: string, isPrivate: boolean) => void }) {
  if (repo.packageType !== 'git') {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
        <Globe className="w-3 h-3" /> Public
      </span>
    );
  }
  return repo.isPrivate ? (
    <button
      title="Mark as Public"
      onClick={(e) => { e.stopPropagation(); onToggle(repo.id, false); }}
      className="flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 hover:bg-amber-100 transition-colors"
    >
      <Lock className="w-3 h-3" /> Private
    </button>
  ) : (
    <button
      title="Mark as Private"
      onClick={(e) => { e.stopPropagation(); onToggle(repo.id, true); }}
      className="flex items-center gap-1 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 hover:bg-slate-100 transition-colors"
    >
      <Globe className="w-3 h-3" /> Public
    </button>
  );
}

export default function AllRepos() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [packageType, setPackageType] = useState('all');
  const [visibility, setVisibility] = useState('all');
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkScanMode, setBulkScanMode] = useState<ScanMode>('both');
  const [bulkForce, setBulkForce] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ queued: number; skipped: number } | null>(null);

  const selectedIds = useMemo(
    () => Object.keys(rowSelection).filter((id) => rowSelection[id]),
    [rowSelection],
  );

  const hasActiveFilters = !!(search || status || packageType !== 'all' || visibility !== 'all');

  const { data, isLoading } = useQuery({
    queryKey: ['repos', page, search, status, packageType, visibility],
    queryFn: () => api.getRepos({ page, pageSize: 20, search, status, packageType, visibility }),
    placeholderData: (prev) => prev,
  }) as { data: { data: Repo[]; total: number; totalPages: number } | undefined; isLoading: boolean };

  const { data: dbTotal } = useQuery({
    queryKey: ['repos', 'total-all'],
    queryFn: async () => {
      const res = await api.getRepos({ page: 1, pageSize: 1 }) as { total: number };
      return res.total;
    },
  });

  const rescan = useMutation({
    mutationFn: (id: string) => api.rescanRepo(id, { scanMode: 'both' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });

  const scanOptions = { scanMode: bulkScanMode, force: bulkForce };

  const bulkRescan = useMutation({
    mutationFn: (ids: string[]) => api.rescanReposBulk(ids, scanOptions),
    onSuccess: (result) => {
      setBulkResult(result);
      setRowSelection({});
      qc.invalidateQueries({ queryKey: ['repos'] });
    },
  });

  const rescanAll = useMutation({
    mutationFn: (useFilters: boolean) =>
      api.rescanAllRepos({
        ...scanOptions,
        useFilters,
        ...(useFilters ? { search, status, packageType, visibility } : {}),
      }),
    onSuccess: (result) => {
      setBulkResult(result);
      setRowSelection({});
      qc.invalidateQueries({ queryKey: ['repos'] });
    },
  });

  const patchVisibility = useMutation({
    mutationFn: ({ id, isPrivate }: { id: string; isPrivate: boolean }) =>
      api.patchRepoVisibility(id, isPrivate),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });

  const deleteRepo = useMutation({
    mutationFn: (id: string) => api.deleteRepo(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });

  const clearAll = useMutation({
    mutationFn: () => api.deleteRepos(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });

  const columns = useMemo<ColumnDef<Repo, unknown>[]>(() => [
    {
      id: 'select',
      header: ({ table }) => (
        <input
          type="checkbox"
          checked={table.getIsAllPageRowsSelected()}
          ref={(el) => {
            if (el) el.indeterminate = table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected();
          }}
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
      header: 'Source',
      cell: ({ row }) => <SourceCell repo={row.original} />,
    },
    {
      header: 'Visibility',
      cell: ({ row }) => (
        <VisibilityToggle
          repo={row.original}
          onToggle={(id, isPrivate) => patchVisibility.mutate({ id, isPrivate })}
        />
      ),
    },
    { header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    {
      header: 'Last Scan',
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{formatRelative(row.original.lastScannedAt)}</span>,
    },
    { header: 'Vulns', cell: ({ row }) => <span className="font-medium">{row.original.vulnCount}</span> },
    { header: 'Exploits', cell: ({ row }) => <span>{row.original.exploitCount}</span> },
    {
      header: 'Actions',
      cell: ({ row }) => (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            variant="outline"
            loading={rescan.isPending}
            disabled={IN_SCAN_STATUSES.has(row.original.status)}
            onClick={() => rescan.mutate(row.original.id)}
            title={IN_SCAN_STATUSES.has(row.original.status) ? 'Already queued or scanning' : 'Re-scan (both pipelines, revision-aware)'}
          >
            <RefreshCw className="w-3 h-3" />
          </Button>
          <ConfirmDialog
            title="Delete Entry"
            description={`Remove "${row.original.packageName ?? row.original.url}" and all associated scans and vulnerabilities?`}
            confirmText="Delete"
            onConfirm={() => deleteRepo.mutate(row.original.id)}
          >
            {(open) => (
              <Button size="sm" variant="ghost" onClick={open}>
                <Trash2 className="w-3 h-3 text-destructive" />
              </Button>
            )}
          </ConfirmDialog>
        </div>
      ),
    },
  ], [patchVisibility, rescan.isPending, deleteRepo]);

  const scanModeLabel = SCAN_MODES.find((m) => m.value === bulkScanMode)?.label ?? bulkScanMode;
  const filteredTotal = data?.total ?? 0;
  const allTotal = dbTotal ?? filteredTotal;
  const queuePending = bulkRescan.isPending || rescanAll.isPending;

  const queueBulkDescription = (count: number, scope: string) =>
    `This will enqueue up to ${count.toLocaleString()} ${scope} for ${scanModeLabel}${
      bulkForce ? ' with force rescan' : ''
    }. This is a heavy operation that can saturate workers and the scan queue for a long time. ` +
    'Only pipelines not yet scanned at the current revision run unless force is enabled.';

  return (
    <Layout
      title="All Repositories"
      subtitle={`${data?.total ?? 0} entries`}
      actions={
        <ConfirmDialog
          title="Clear All"
          description="This will delete all entries, scans, and vulnerabilities. This action cannot be undone."
          requireTyped="DELETE ALL"
          confirmText="Clear All"
          onConfirm={() => clearAll.mutate()}
        >
          {(open) => (
            <Button variant="destructive" size="sm" onClick={open}>
              <Trash2 className="w-3.5 h-3.5" /> Clear All
            </Button>
          )}
        </ConfirmDialog>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2 flex-wrap items-end">
          <Input
            placeholder="Search name or URL..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="max-w-xs"
          />
          <Select value={packageType} onChange={(e) => { setPackageType(e.target.value); setPage(1); }}>
            <option value="all">All types</option>
            <option value="git">Git repos</option>
            <option value="npm">npm packages</option>
            <option value="pip">pip packages</option>
            <option value="cargo">Cargo crates</option>
            <option value="go">Go modules</option>
            <option value="gem">Ruby gems</option>
          </Select>
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            {['queued', 'cloning', 'scanning', 'exploiting', 'done', 'failed', 'skipped'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
          <Select value={visibility} onChange={(e) => { setVisibility(e.target.value); setPage(1); }}>
            <option value="all">All visibility</option>
            <option value="public">Public</option>
            <option value="private">Private / Internal</option>
          </Select>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-md border border-border bg-muted/30">
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <span className="text-sm font-semibold">Bulk scan</span>
            <Select
              value={bulkScanMode}
              onChange={(e) => setBulkScanMode(e.target.value as ScanMode)}
              className="w-36"
            >
              {SCAN_MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </Select>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={bulkForce}
                onChange={(e) => setBulkForce(e.target.checked)}
                className="rounded border-border accent-primary"
              />
              <span>Force rescan</span>
            </label>

            {selectedIds.length > 0 && (
              <>
                <span className="text-sm text-muted-foreground">|</span>
                <span className="text-sm font-medium">{selectedIds.length} selected</span>
                <ConfirmDialog
                  title="Queue selected repositories?"
                  description={queueBulkDescription(selectedIds.length, 'selected repositories')}
                  confirmText={`Queue selected (${selectedIds.length})`}
                  onConfirm={async () => {
                    setBulkResult(null);
                    await bulkRescan.mutateAsync(selectedIds);
                  }}
                >
                  {(open) => (
                    <Button
                      size="sm"
                      loading={queuePending}
                      disabled={queuePending}
                      onClick={open}
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Queue selected
                    </Button>
                  )}
                </ConfirmDialog>
                <Button size="sm" variant="ghost" onClick={() => setRowSelection({})}>
                  Clear selection
                </Button>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {hasActiveFilters && (
              <ConfirmDialog
                title="Queue matching repositories?"
                description={queueBulkDescription(filteredTotal, 'repositories matching current filters')}
                requireTyped="QUEUE ALL"
                confirmText={`Queue matching (${filteredTotal})`}
                onConfirm={async () => { setBulkResult(null); await rescanAll.mutateAsync(true); }}
              >
                {(open) => (
                  <Button
                    size="sm"
                    variant="outline"
                    loading={queuePending}
                    disabled={queuePending || filteredTotal === 0}
                    onClick={open}
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Queue matching ({filteredTotal})
                  </Button>
                )}
              </ConfirmDialog>
            )}

            <ConfirmDialog
              title="Queue all repositories?"
              description={queueBulkDescription(allTotal, 'repositories in the database')}
              requireTyped="QUEUE ALL"
              confirmText={`Queue all (${allTotal})`}
              onConfirm={async () => { setBulkResult(null); await rescanAll.mutateAsync(false); }}
            >
              {(open) => (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={queuePending}
                  disabled={queuePending || allTotal === 0}
                  onClick={open}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Queue all ({allTotal})
                </Button>
              )}
            </ConfirmDialog>
          </div>
        </div>

        {bulkResult && (
          <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-4 py-3">
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
            Queued <strong>{bulkResult.queued}</strong> for scanning.
            {bulkResult.skipped > 0 && (
              <> Skipped <strong>{bulkResult.skipped}</strong> (unchanged revision, in queue, or not found).</>
            )}
            <button
              type="button"
              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setBulkResult(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {(bulkRescan.isError || rescanAll.isError) && (
          <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-4 py-3">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {String(bulkRescan.error ?? rescanAll.error)}
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
          </div>
        ) : (
          <>
            <DataTable
              data={data?.data ?? []}
              columns={columns}
              rowSelection={rowSelection}
              onRowSelectionChange={setRowSelection}
              getRowId={(row) => row.id}
            />
            <Pagination page={page} totalPages={data?.totalPages ?? 1} onPage={setPage} total={data?.total ?? 0} pageSize={20} />
          </>
        )}
      </div>
    </Layout>
  );
}
