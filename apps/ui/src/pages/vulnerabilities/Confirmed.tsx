import { useState, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type ColumnDef, type RowSelectionState } from '@tanstack/react-table';
import { Copy, Check, Download, Zap, FileText, Eye, X, Trash2, CircleCheck } from 'lucide-react';
import { Layout } from '../../components/Layout.tsx';
import { DataTable, Pagination } from '../../components/ui/DataTable.tsx';
import { Button } from '../../components/ui/Button.tsx';
import { Input } from '../../components/ui/Input.tsx';
import { Select } from '../../components/ui/Select.tsx';
import { SeverityBadge, Badge, ExploitStatusIcon } from '../../components/ui/Badge.tsx';
import { Modal, ConfirmDialog, VULN_DETAIL_MODAL_SIZE_KEY } from '../../components/ui/Dialog.tsx';
import { api } from '../../lib/api.ts';
import { RepoUrlLink } from '../../components/RepoUrlLink.tsx';
import { ReportViewerModal } from '../../components/ReportViewerModal.tsx';
import { Tooltip } from '../../components/ui/Tooltip.tsx';
import { formatDate, formatFileLine, formatVulnIdShort } from '../../lib/utils.ts';
import type { ApiVulnerability } from '@secscan/shared';

function CveReportedCell({
  vuln,
  onUpdated,
}: {
  vuln: ApiVulnerability;
  onUpdated: () => void;
}) {
  const mutation = useMutation({
    mutationFn: (val: boolean) => api.setCveReported(vuln.id, val),
    onSuccess: onUpdated,
  });

  return (
    <Button
      size="sm"
      variant={vuln.cveReported ? 'secondary' : 'outline'}
      loading={mutation.isPending}
      onClick={(e) => {
        e.stopPropagation();
        mutation.mutate(!vuln.cveReported);
      }}
      title={vuln.cveReported ? 'Unmark CVE reported' : 'Mark as reported CVE'}
      className="h-7 text-xs"
    >
      <CircleCheck className="w-3.5 h-3.5" />
      {vuln.cveReported ? 'Done' : 'Mark'}
    </Button>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function VulnDetail({
  vuln: vulnProp,
  onClose,
  onVulnChange,
}: {
  vuln: ApiVulnerability;
  onClose: () => void;
  onVulnChange?: (vuln: ApiVulnerability) => void;
}) {
  const qc = useQueryClient();
  const [vuln, setVuln] = useState(vulnProp);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    setVuln(vulnProp);
  }, [vulnProp]);

  const patchVuln = useCallback((patch: Partial<ApiVulnerability>) => {
    setVuln((prev) => {
      const next = { ...prev, ...patch };
      onVulnChange?.(next);
      return next;
    });
  }, [onVulnChange]);
  const meta = (vuln.metadataJson ?? {}) as {
    dataflow_steps?: string[]; confidence_reasons?: string[];
    trust_boundary?: string; requires_auth?: string; requires_misconfig?: boolean;
    source_location?: string; sink_location?: string; confidence?: string;
  };
  const hasMetaContext = !!(meta.requires_auth || meta.requires_misconfig != null || meta.trust_boundary);

  const fpMutation = useMutation({
    mutationFn: (val: boolean) => api.setFalsePositive(vuln.id, val),
    onSuccess: (_data, value) => {
      patchVuln({ isFalsePositive: value });
      qc.invalidateQueries({ queryKey: ['vulns'] });
    },
  });

  const cveReportedMutation = useMutation({
    mutationFn: (val: boolean) => api.setCveReported(vuln.id, val),
    onSuccess: (data) => {
      const res = data as { cveReported: boolean; cveReportedAt: string | null };
      patchVuln({
        cveReported: res.cveReported,
        cveReportedAt: res.cveReportedAt,
      });
      qc.invalidateQueries({ queryKey: ['vulns'] });
    },
  });

  const exploitMutation = useMutation({
    mutationFn: () => api.generateExploit(vuln.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vulns'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteVulnerability(vuln.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vulns'] });
      onClose();
    },
  });

  const hasArtifacts = !!(vuln.reportPath || vuln.exploitPath || vuln.payloadPath);
  const needsDeleteConfirm = vuln.exploitStatus !== null || hasArtifacts;

  const copyFindingId = async () => {
    try {
      await navigator.clipboard.writeText(vuln.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      alert('Could not copy to clipboard');
    }
  };

  const handleDownload = async (type: 'zip' | 'report' | 'exploit' | 'payload') => {
    setDownloading(type);
    try {
      if (type === 'zip') {
        const blob = await api.downloadExploit(vuln.id);
        downloadBlob(blob, `exploit-${vuln.id}.zip`);
        return;
      }
      const fileMap = { report: 'report.md', exploit: 'exploit.py', payload: 'payload.py' } as const;
      const blob = await api.downloadExploitFile(vuln.id, fileMap[type]);
      downloadBlob(blob, fileMap[type]);
    } catch (err) {
      alert(String(err));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <>
    <Modal
      open={true}
      title="Vulnerability Detail"
      onClose={onClose}
      resizable
      sizeStorageKey={VULN_DETAIL_MODAL_SIZE_KEY}
    >
      <div className="space-y-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
          <SeverityBadge severity={vuln.severity} />
          <span className="font-mono text-xs text-muted-foreground">{vuln.cwe}</span>
          {vuln.isFalsePositive && <Badge variant="secondary">False Positive</Badge>}
          {vuln.cveReported && <Badge variant="default">CVE Reported</Badge>}
          {vuln.cvssScore !== null && (
            <Badge variant="outline">CVSS {vuln.cvssScore}</Badge>
          )}
          </div>
          <Button size="sm" variant="outline" onClick={copyFindingId} title="Copy finding ID to clipboard">
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy ID'}
          </Button>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Finding ID</p>
          <p className="font-mono text-xs break-all">{vuln.id}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Repo</p>
          <RepoUrlLink repoUrl={vuln.repoUrl} fullWidth className="text-sm" />
        </div>
        {(vuln.githubStars != null || vuln.privateVulnerabilityReportingEnabled != null) && (
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-muted-foreground">GitHub stars</p>
              <p>{vuln.githubStars != null ? vuln.githubStars.toLocaleString() : '—'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">PVR</p>
              <p>
                {vuln.privateVulnerabilityReportingEnabled === true
                  ? 'Enabled'
                  : vuln.privateVulnerabilityReportingEnabled === false
                    ? 'Disabled'
                    : '—'}
              </p>
            </div>
          </div>
        )}
        {vuln.packageRepoUrl && (
          <div>
            <p className="text-xs text-muted-foreground">Repo URL</p>
            <a
              href={vuln.packageRepoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs break-all text-blue-600 hover:underline"
            >
              {vuln.packageRepoUrl}
            </a>
          </div>
        )}
        {vuln.packageTarballUrl && (
          <div>
            <p className="text-xs text-muted-foreground">Package Tarball URL</p>
            <a
              href={vuln.packageTarballUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs break-all text-blue-600 hover:underline"
            >
              {vuln.packageTarballUrl}
            </a>
          </div>
        )}
        <div>
          <p className="text-xs text-muted-foreground">Location</p>
          <p className="font-mono text-xs">{vuln.path}:{vuln.lineStart}{vuln.lineEnd ? `–${vuln.lineEnd}` : ''}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Message</p>
          <p className="text-xs">{vuln.message}</p>
        </div>
        {(vuln.dropReason || vuln.dropEvidence) && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Drop info</p>
            {vuln.dropReason && (
              <div>
                <p className="text-xs text-muted-foreground">Drop Reason</p>
                <Badge variant="secondary" className="mt-0.5">{vuln.dropReason}</Badge>
              </div>
            )}
            {vuln.dropEvidence && (
              <div>
                <p className="text-xs text-muted-foreground">Drop Evidence</p>
                <p className="text-xs break-words">{vuln.dropEvidence}</p>
              </div>
            )}
          </div>
        )}
        {meta.source_location && (
          <div>
            <p className="text-xs text-muted-foreground">Source → Sink</p>
            <p className="font-mono text-xs text-amber-700">{meta.source_location}</p>
            <p className="font-mono text-xs mt-0.5">↓</p>
            <p className="font-mono text-xs text-red-700">{meta.sink_location}</p>
          </div>
        )}
        {meta.dataflow_steps && meta.dataflow_steps.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-1">Dataflow Steps</p>
            <ol className="space-y-1">
              {meta.dataflow_steps.map((step, i) => (
                <li key={i} className="flex gap-1.5 text-xs">
                  <span className="text-muted-foreground flex-shrink-0">{i + 1}.</span>
                  <span className="font-mono break-all">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {meta.confidence_reasons && meta.confidence_reasons.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-1">Confidence</p>
            <p className="text-xs mb-1 font-medium capitalize">{meta.confidence}</p>
            {meta.confidence_reasons.map((r, i) => (
              <p key={i} className="text-xs text-muted-foreground">• {r}</p>
            ))}
          </div>
        )}
        {hasMetaContext && (
          <div className="grid grid-cols-3 gap-1 text-xs">
            <div><p className="text-muted-foreground">Auth</p><p>{meta.requires_auth ?? '—'}</p></div>
            <div><p className="text-muted-foreground">Misconfig</p><p>{meta.requires_misconfig ? 'Yes' : 'No'}</p></div>
            <div><p className="text-muted-foreground">Boundary</p><p>{meta.trust_boundary ?? '—'}</p></div>
          </div>
        )}
        <div className="border-t border-border pt-3 space-y-2">
          {hasArtifacts && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Exploit artifacts</p>
              <div className="flex flex-wrap gap-2">
                {vuln.reportPath && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setReportOpen(true)}>
                      <Eye className="w-3.5 h-3.5" /> View report
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      loading={downloading === 'report'}
                      onClick={() => handleDownload('report')}
                    >
                      <FileText className="w-3.5 h-3.5" /> report.md
                    </Button>
                  </>
                )}
                {vuln.exploitPath && (
                  <Button
                    size="sm"
                    variant="outline"
                    loading={downloading === 'exploit'}
                    onClick={() => handleDownload('exploit')}
                  >
                    exploit.py
                  </Button>
                )}
                {vuln.payloadPath && (
                  <Button
                    size="sm"
                    variant="outline"
                    loading={downloading === 'payload'}
                    onClick={() => handleDownload('payload')}
                  >
                    payload.py
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  loading={downloading === 'zip'}
                  onClick={() => handleDownload('zip')}
                >
                  <Download className="w-3.5 h-3.5" /> ZIP
                </Button>
              </div>
            </div>
          )}
          {vuln.exploitStatus !== 'done' && vuln.exploitStatus !== 'generating' && vuln.exploitStatus !== 'pending' ? (
            <Button size="sm" className="w-full" loading={exploitMutation.isPending} onClick={() => exploitMutation.mutate()}>
              <Zap className="w-3.5 h-3.5" /> Generate Exploit
            </Button>
          ) : vuln.exploitStatus === 'pending' || vuln.exploitStatus === 'generating' ? (
            <p className="text-xs text-muted-foreground">Exploit generation in progress…</p>
          ) : !hasArtifacts ? (
            <p className="text-xs text-muted-foreground">Exploit finished — no artifact files on disk.</p>
          ) : null}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">False Positive</span>
            <button
              onClick={() => fpMutation.mutate(!vuln.isFalsePositive)}
              className={`relative w-9 h-5 rounded-full transition-colors ${vuln.isFalsePositive ? 'bg-primary' : 'bg-muted'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${vuln.isFalsePositive ? 'translate-x-4' : ''}`} />
            </button>
          </div>
          <Button
            size="sm"
            variant={vuln.cveReported ? 'outline' : 'default'}
            className="w-full"
            loading={cveReportedMutation.isPending}
            onClick={() => cveReportedMutation.mutate(!vuln.cveReported)}
          >
            <CircleCheck className="w-3.5 h-3.5" />
            {vuln.cveReported ? 'Unmark CVE reported' : 'Mark CVE reported'}
          </Button>
          {needsDeleteConfirm ? (
            <ConfirmDialog
              title="Delete Vulnerability"
              description="This finding has been exploited or has report/artifact files. Deleting will permanently remove the record and all associated files."
              confirmText="Delete"
              onConfirm={async () => { await deleteMutation.mutateAsync(); }}
            >
              {(open) => (
                <Button
                  size="sm"
                  variant="destructive"
                  className="w-full"
                  loading={deleteMutation.isPending}
                  onClick={open}
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </Button>
              )}
            </ConfirmDialog>
          ) : (
            <Button
              size="sm"
              variant="destructive"
              className="w-full"
              loading={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </Button>
          )}
        </div>
      </div>
    </Modal>
    <ReportViewerModal vulnId={vuln.id} open={reportOpen} onClose={() => setReportOpen(false)} />
    </>
  );
}

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;

export default function Confirmed() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [severity, setSeverity] = useState('');
  const [exploitFilter, setExploitFilter] = useState('');
  const [fpFilter, setFpFilter] = useState('');
  const [cwe, setCwe] = useState('');
  const [vulnType, setVulnType] = useState('');
  const [pvrFilter, setPvrFilter] = useState('');
  const [cveReportedFilter, setCveReportedFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ApiVulnerability | null>(null);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);
  const selectedCount = selectedIds.length;

  const { data, isLoading } = useQuery({
    queryKey: ['vulns', page, pageSize, severity, exploitFilter, fpFilter, cwe, vulnType, pvrFilter, cveReportedFilter, search],
    queryFn: () => api.getVulnerabilities({
      page,
      pageSize,
      severity,
      repoUrl: search,
      ...(exploitFilter ? { exploitStatus: exploitFilter } : {}),
      ...(fpFilter ? { falsePositive: fpFilter } : {}),
      ...(cveReportedFilter ? { cveReported: cveReportedFilter } : {}),
      ...(cwe ? { cwe } : {}),
      ...(vulnType ? { vulnType } : {}),
      ...(pvrFilter ? { pvr: pvrFilter } : {}),
    }),
    placeholderData: (prev) => prev,
  }) as { data: { data: ApiVulnerability[]; total: number; totalPages: number } | undefined; isLoading: boolean };

  const bulkExploitMutation = useMutation({
    mutationFn: () => api.bulkExploit({ vulnIds: selectedIds, onlyNew: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vulns'] });
      setRowSelection({});
    },
  });

  const handleRowClick = useCallback((row: ApiVulnerability) => {
    setSelected(row);
  }, []);

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
    {
      id: 'stars',
      header: 'Stars',
      cell: ({ row }) => (
        <span className="text-xs tabular-nums">
          {row.original.githubStars != null && row.original.githubStars >= 0
            ? row.original.githubStars.toLocaleString()
            : '—'}
        </span>
      ),
    },
    {
      id: 'pvr',
      header: () => (
        <Tooltip content="GitHub private vulnerability reporting (Report a vulnerability)">
          <span>PVR</span>
        </Tooltip>
      ),
      cell: ({ row }) => {
        const pvr = row.original.privateVulnerabilityReportingEnabled;
        if (pvr === true) return <Badge variant="default" className="text-xs">On</Badge>;
        if (pvr === false) return <Badge variant="outline" className="text-xs">Off</Badge>;
        return <span className="text-xs text-muted-foreground">—</span>;
      },
    },
    { header: 'Repo / Package', cell: ({ row }) => (
      <RepoUrlLink repoUrl={row.original.repoUrl} display="table" />
    ) },
    { header: 'Severity', cell: ({ row }) => <SeverityBadge severity={row.original.severity} /> },
    { header: 'CWE', cell: ({ row }) => <span className="font-mono text-xs">{row.original.cwe}</span> },
    { header: 'Type', cell: ({ row }) => <span className="text-xs">{row.original.vulnType}</span> },
    { header: 'File:Line', cell: ({ row }) => (
      <span
        className="font-mono text-xs block max-w-md truncate"
        title={`${row.original.path}:${row.original.lineStart}`}
      >
        {formatFileLine(row.original.path, row.original.lineStart, row.original.lineEnd)}
      </span>
    ) },
    { header: 'Found', cell: ({ row }) => <span className="text-xs text-muted-foreground">{formatDate(row.original.createdAt)}</span> },
    {
      header: 'FP',
      cell: ({ row }) => row.original.isFalsePositive
        ? <Badge variant="secondary">Yes</Badge>
        : <span className="text-xs text-muted-foreground">—</span>,
    },
    {
      id: 'exploit',
      header: () => (
        <Tooltip content="Exploit status">
          <Zap className="w-4 h-4" aria-label="Exploit status" />
        </Tooltip>
      ),
      cell: ({ row }) => <ExploitStatusIcon status={row.original.exploitStatus} />,
    },
    {
      id: 'cve-reported',
      header: 'CVE',
      cell: ({ row }) => (
        <CveReportedCell vuln={row.original} onUpdated={() => qc.invalidateQueries({ queryKey: ['vulns'] })} />
      ),
    },
  ];

  return (
    <Layout title="Confirmed Vulnerabilities" subtitle={`${data?.total ?? 0} findings`}>
      <div className="space-y-4">
        <div className="flex gap-2 flex-wrap">
          <Input placeholder="Filter by repo..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="max-w-xs" />
          <Input placeholder="Filter by CWE..." value={cwe} onChange={(e) => { setCwe(e.target.value); setPage(1); }} className="max-w-[140px]" />
          <Input placeholder="Filter by type..." value={vulnType} onChange={(e) => { setVulnType(e.target.value); setPage(1); }} className="max-w-[160px]" />
          <Select value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }}>
            <option value="">All severities</option>
            {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Select value={exploitFilter} onChange={(e) => { setExploitFilter(e.target.value); setPage(1); }}>
            <option value="">All exploit states</option>
            <option value="done">Exploitable</option>
            <option value="in_progress">In progress</option>
            <option value="failed">Failed</option>
            <option value="none">Not tried</option>
          </Select>
          <Select value={fpFilter} onChange={(e) => { setFpFilter(e.target.value); setPage(1); }}>
            <option value="">All false positives</option>
            <option value="yes">False positive only</option>
            <option value="no">Exclude false positives</option>
          </Select>
          <Select value={pvrFilter} onChange={(e) => { setPvrFilter(e.target.value); setPage(1); }} title="Private vulnerability reporting">
            <option value="">All PVR</option>
            <option value="enabled">PVR enabled</option>
            <option value="disabled">PVR disabled</option>
            <option value="unknown">PVR unknown</option>
          </Select>
          <Select value={cveReportedFilter} onChange={(e) => { setCveReportedFilter(e.target.value); setPage(1); }}>
            <option value="">All CVE status</option>
            <option value="no">Not reported</option>
            <option value="yes">CVE reported</option>
          </Select>
        </div>

        {selectedCount > 0 && (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-4 py-2.5">
            <span className="text-sm font-medium text-foreground">
              {selectedCount} {selectedCount === 1 ? 'vulnerability' : 'vulnerabilities'} selected
            </span>
            <div className="flex items-center gap-2 ml-auto">
              {bulkExploitMutation.isSuccess && (
                <span className="text-xs text-green-600 font-medium">
                  {bulkExploitMutation.data?.queued ?? 0} queued
                </span>
              )}
              {bulkExploitMutation.isError && (
                <span className="text-xs text-destructive">
                  {String(bulkExploitMutation.error)}
                </span>
              )}
              <Button
                size="sm"
                loading={bulkExploitMutation.isPending}
                onClick={() => bulkExploitMutation.mutate()}
              >
                <Zap className="w-3.5 h-3.5" />
                Queue for Exploit
              </Button>
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
              getRowClassName={(row) => row.cveReported ? 'opacity-60' : ''}
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
        <VulnDetail
          vuln={selected}
          onClose={() => setSelected(null)}
          onVulnChange={setSelected}
        />
      )}
    </Layout>
  );
}
