import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type ColumnDef } from '@tanstack/react-table';
import { Copy, Check, Download, Zap, FileText, Eye } from 'lucide-react';
import { Layout } from '../../components/Layout.tsx';
import { DataTable, Pagination } from '../../components/ui/DataTable.tsx';
import { Button } from '../../components/ui/Button.tsx';
import { Input } from '../../components/ui/Input.tsx';
import { Select } from '../../components/ui/Select.tsx';
import { SeverityBadge, Badge } from '../../components/ui/Badge.tsx';
import { Modal } from '../../components/ui/Dialog.tsx';
import { api } from '../../lib/api.ts';
import { RepoUrlLink } from '../../components/RepoUrlLink.tsx';
import { ReportViewerModal } from '../../components/ReportViewerModal.tsx';
import { formatDate, formatFileLine } from '../../lib/utils.ts';
import type { ApiVulnerability } from '@secscan/shared';

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function VulnDetail({ vuln, onClose }: { vuln: ApiVulnerability; onClose: () => void }) {
  const qc = useQueryClient();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const meta = (vuln.metadataJson ?? {}) as {
    dataflow_steps?: string[]; confidence_reasons?: string[];
    trust_boundary?: string; requires_auth?: string; requires_misconfig?: boolean;
    source_location?: string; sink_location?: string; confidence?: string;
  };
  const hasMetaContext = !!(meta.requires_auth || meta.requires_misconfig != null || meta.trust_boundary);

  const fpMutation = useMutation({
    mutationFn: (val: boolean) => api.setFalsePositive(vuln.id, val),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vulns'] }),
  });

  const exploitMutation = useMutation({
    mutationFn: () => api.generateExploit(vuln.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vulns'] }),
  });

  const hasArtifacts = !!(vuln.reportPath || vuln.exploitPath || vuln.payloadPath);

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
    <Modal open={true} title="Vulnerability Detail" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
          <SeverityBadge severity={vuln.severity} />
          <span className="font-mono text-xs text-muted-foreground">{vuln.cwe}</span>
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
          <RepoUrlLink repoUrl={vuln.repoUrl} className="max-w-none text-sm break-all" />
        </div>
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
        </div>
      </div>
    </Modal>
    <ReportViewerModal vulnId={vuln.id} open={reportOpen} onClose={() => setReportOpen(false)} />
    </>
  );
}

export default function Confirmed() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [severity, setSeverity] = useState('');
  const [exploitable, setExploitable] = useState('');
  const [cwe, setCwe] = useState('');
  const [vulnType, setVulnType] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ApiVulnerability | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['vulns', page, severity, exploitable, cwe, vulnType, search],
    queryFn: () => api.getVulnerabilities({
      page,
      pageSize: 20,
      severity,
      repoUrl: search,
      ...(exploitable ? { exploitable } : {}),
      ...(cwe ? { cwe } : {}),
      ...(vulnType ? { vulnType } : {}),
    }),
    placeholderData: (prev) => prev,
  }) as { data: { data: ApiVulnerability[]; total: number; totalPages: number } | undefined; isLoading: boolean };

  const columns: ColumnDef<ApiVulnerability, unknown>[] = [
    { header: 'Vuln ID', cell: ({ row }) => (
      <span className="font-mono text-xs" title={row.original.id}>{row.original.id}</span>
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
    { header: 'Repo', cell: ({ row }) => <RepoUrlLink repoUrl={row.original.repoUrl} /> },
    { header: 'Found', cell: ({ row }) => <span className="text-xs text-muted-foreground">{formatDate(row.original.createdAt)}</span> },
    {
      header: 'Exploit',
      cell: ({ row }) => {
        const s = row.original.exploitStatus;
        if (s === 'done') return <Badge variant="success">Exploitable</Badge>;
        if (s === 'pending' || s === 'generating') return <Badge variant="warning">In progress</Badge>;
        if (s === 'failed') return <Badge variant="destructive">Failed</Badge>;
        return <Badge variant="outline">Not exploitable</Badge>;
      },
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
          <Select value={exploitable} onChange={(e) => { setExploitable(e.target.value); setPage(1); }}>
            <option value="">All exploitability</option>
            <option value="yes">Exploitable</option>
            <option value="no">Not exploitable</option>
          </Select>
        </div>
        {isLoading ? (
          <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" /></div>
        ) : (
          <>
            <DataTable data={data?.data ?? []} columns={columns} onRowClick={(row) => setSelected(row)} />
            <Pagination page={page} totalPages={data?.totalPages ?? 1} onPage={setPage} total={data?.total ?? 0} pageSize={20} />
          </>
        )}
      </div>
      {selected && <VulnDetail vuln={selected} onClose={() => setSelected(null)} />}
    </Layout>
  );
}
