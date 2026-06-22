import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Upload, FileText, AlertCircle, CheckCircle, Lock, Globe, Package, ChevronDown, Plus } from 'lucide-react';
import { Layout } from '../../components/Layout.tsx';
import { Button } from '../../components/ui/Button.tsx';
import { Card } from '../../components/ui/Card.tsx';
import { Badge } from '../../components/ui/Badge.tsx';
import { Input } from '../../components/ui/Input.tsx';
import { Select } from '../../components/ui/Select.tsx';
import { api } from '../../lib/api.ts';
import { cn } from '../../lib/utils.ts';

type PackageType = 'git' | 'npm' | 'pip' | 'cargo' | 'go' | 'gem';
type ScanMode = 'both' | 'cve' | 'secrets';

const SCAN_MODES: { value: ScanMode; label: string; description: string }[] = [
  { value: 'both', label: 'Both', description: 'CVE hunt + secret scan' },
  { value: 'cve', label: 'CVE Hunt', description: 'cve-ai-finder (default) or Semgrep + cve-pattern-hunter via CVE_SCAN_MODE' },
  { value: 'secrets', label: 'Secrets', description: 'Gitleaks + TruffleHog + triage only' },
];

interface PreviewRow {
  url: string;
  packageType: PackageType;
  packageName?: string;
  packageVersion?: string;
  provider: string;
  isPrivate: boolean;
  exists: boolean;
  inQueue?: boolean;
}

interface PreviewResult {
  preview: PreviewRow[];
  total: number;
  duplicates: number;
}

type ManualTarget =
  | { gitUrl: string; isPrivate?: boolean }
  | { packageName: string; packageType: Exclude<PackageType, 'git'>; packageVersion?: string };

interface ManualEntry {
  target: ManualTarget;
  preview: PreviewRow;
}

const PKG_COLORS: Record<string, string> = {
  npm: 'text-red-700 bg-red-50 border-red-200',
  pip: 'text-blue-700 bg-blue-50 border-blue-200',
  cargo: 'text-orange-700 bg-orange-50 border-orange-200',
  go: 'text-cyan-700 bg-cyan-50 border-cyan-200',
  gem: 'text-rose-700 bg-rose-50 border-rose-200',
  git: '',
};

const PACKAGE_TYPES: { value: PackageType; label: string }[] = [
  { value: 'git', label: 'Git repository' },
  { value: 'npm', label: 'npm' },
  { value: 'pip', label: 'pip' },
  { value: 'cargo', label: 'Cargo' },
  { value: 'go', label: 'Go module' },
  { value: 'gem', label: 'Ruby gem' },
];

function PreviewList({ rows }: { rows: PreviewRow[] }) {
  return (
    <div className="max-h-80 overflow-y-auto">
      {rows.map((row, i) => (
        <div
          key={`${row.url}-${i}`}
          className={cn(
            'px-4 py-2.5 flex items-center gap-2 text-sm border-b border-border last:border-0',
            row.exists && 'bg-amber-50/50',
          )}
        >
          {row.packageType !== 'git' ? (
            <span className={cn('flex items-center gap-1 text-xs border rounded px-1.5 py-0.5 shrink-0 font-medium', PKG_COLORS[row.packageType])}>
              <Package className="w-3 h-3" /> {row.packageType.toUpperCase()}
            </span>
          ) : (
            <Badge variant={row.provider === 'github' ? 'default' : row.provider === 'bitbucket' ? 'secondary' : 'outline'} className="shrink-0 text-xs">
              {row.provider}
            </Badge>
          )}

          <span className="flex-1 font-mono text-xs truncate">
            {row.packageType !== 'git' ? row.packageName : row.url}
            {row.packageVersion && <span className="text-muted-foreground ml-1">@{row.packageVersion}</span>}
          </span>

          {row.packageType === 'git' && (
            row.isPrivate ? (
              <span className="flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 shrink-0" title="Declared private">
                <Lock className="w-3 h-3" /> Private
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 shrink-0" title="Assumed public — confirmed when scanner clones">
                <Globe className="w-3 h-3" /> Public*
              </span>
            )
          )}

          {row.inQueue && <Badge variant="secondary" className="shrink-0 text-xs">In queue</Badge>}
          {row.exists && !row.inQueue && (
            <span title="Already in database — will re-queue pending pipelines">
              <Badge variant="warning" className="shrink-0 text-xs">In DB</Badge>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export default function Import() {
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<PreviewResult | null>(null);
  const [manualEntries, setManualEntries] = useState<ManualEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [manualLoading, setManualLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ queued: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [formatsOpen, setFormatsOpen] = useState(false);

  const [entryType, setEntryType] = useState<PackageType>('git');
  const [entryName, setEntryName] = useState('');
  const [entryVersion, setEntryVersion] = useState('');
  const [entryPrivate, setEntryPrivate] = useState(false);
  const [scanMode, setScanMode] = useState<ScanMode>('both');
  const [forceRescan, setForceRescan] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const combinedPreview = useMemo(() => {
    const fileRows = filePreview?.preview ?? [];
    const manualRows = manualEntries.map((e) => e.preview);
    const seen = new Set<string>();
    const merged: PreviewRow[] = [];
    for (const row of [...fileRows, ...manualRows]) {
      if (seen.has(row.url)) continue;
      seen.add(row.url);
      merged.push(row);
    }
    const duplicates = merged.filter((r) => r.exists).length;
    return { preview: merged, total: merged.length, duplicates };
  }, [filePreview, manualEntries]);

  const resetResults = () => {
    setResult(null);
    setError(null);
  };

  const handleFile = async (f: File) => {
    setFile(f);
    setFilePreview(null);
    resetResults();
    setLoading(true);
    try {
      const res = await api.previewImport(f);
      setFilePreview(res as PreviewResult);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const buildManualTarget = (): ManualTarget | null => {
    const name = entryName.trim();
    if (!name) return null;
    if (entryType === 'git') {
      return { gitUrl: name, isPrivate: entryPrivate };
    }
    const version = entryVersion.trim();
    return {
      packageName: name,
      packageType: entryType,
      ...(version ? { packageVersion: version } : {}),
    };
  };

  const handleAddManual = async () => {
    const target = buildManualTarget();
    if (!target) {
      setError('Enter a repository URL or package name.');
      return;
    }

    resetResults();
    setManualLoading(true);
    try {
      const res = await api.previewImportManual(target);
      const preview = res.preview as PreviewRow;
      setManualEntries((prev) => {
        if (prev.some((e) => e.preview.url === preview.url)) return prev;
        return [...prev, { target, preview }];
      });
      setEntryName('');
      setEntryVersion('');
      setEntryPrivate(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setManualLoading(false);
    }
  };

  const handleImport = async () => {
    const hasFile = !!file;
    const hasManual = manualEntries.length > 0;
    if (!hasFile && !hasManual) return;

    setImporting(true);
    resetResults();
    try {
      let queued = 0;
      let skipped = 0;
      const importOptions = { scanMode, force: forceRescan };

      if (hasFile) {
        const res = await api.importRepos(file!, importOptions) as { queued: number; skipped: number };
        queued += res.queued;
        skipped += res.skipped;
      }

      if (hasManual) {
        const res = await api.importManual(manualEntries.map((e) => e.target), importOptions);
        queued += res.queued;
        skipped += res.skipped;
      }

      setResult({ queued, skipped });
      setManualEntries([]);
      setFile(null);
      setFilePreview(null);
      qc.invalidateQueries({ queryKey: ['repos'] });
    } catch (err) {
      setError(String(err));
    } finally {
      setImporting(false);
    }
  };

  const newCount = combinedPreview.preview.filter((r) => !r.exists).length;
  const existingCount = combinedPreview.duplicates;
  const hasEntries = combinedPreview.total > 0;
  const canQueue = !!file || manualEntries.length > 0;
  const isGit = entryType === 'git';

  return (
    <Layout title="Import" subtitle="Upload a CSV or add repos and packages manually">
      <div className="max-w-5xl space-y-6">

        <Card className="p-4">
          <p className="text-sm font-semibold mb-2">Scan type</p>
          <p className="text-xs text-muted-foreground mb-3">
            Choose which pipelines run for each target. Existing repos are re-queued; only pipelines not yet scanned at the current commit/version run (unless force is enabled).
          </p>
          <div className="flex flex-wrap gap-2">
            {SCAN_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                onClick={() => setScanMode(mode.value)}
                className={cn(
                  'px-3 py-2 rounded-md border text-left text-sm transition-colors min-w-[140px]',
                  scanMode === mode.value
                    ? 'border-primary bg-accent text-primary font-medium'
                    : 'border-border hover:bg-accent/50 text-muted-foreground',
                )}
              >
                <span className="block font-medium">{mode.label}</span>
                <span className="block text-xs mt-0.5 opacity-80">{mode.description}</span>
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer mt-3">
            <input
              type="checkbox"
              checked={forceRescan}
              onChange={(e) => setForceRescan(e.target.checked)}
              className="rounded border-border"
            />
            <span>
              Force rescan
              <span className="text-xs text-muted-foreground ml-1">
                — re-run selected pipelines even when commit/version is unchanged
              </span>
            </span>
          </label>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left — file upload */}
          <Card className="p-0 overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
              <p className="text-sm font-semibold">Upload CSV</p>
              <p className="text-xs text-muted-foreground mt-0.5">Bulk import from a file</p>
            </div>
            <div
              className={cn(
                'm-4 border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors min-h-[220px] flex flex-col items-center justify-center',
                dragging ? 'border-primary bg-accent' : 'border-border hover:border-primary/50 hover:bg-accent/30',
              )}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files[0];
                if (f) handleFile(f);
              }}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.txt"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
              <Upload className="mb-3 text-muted-foreground w-8 h-8" />
              <p className="text-sm font-medium">Drop a CSV file here or click to browse</p>
              <p className="text-xs text-muted-foreground mt-1">One entry per line</p>
              {file && (
                <p className="text-xs text-primary mt-3 font-medium">
                  <FileText className="inline w-3.5 h-3.5 mr-1" />
                  {file.name}
                </p>
              )}
            </div>
          </Card>

          {/* Right — manual entry */}
          <Card className="p-0 overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
              <p className="text-sm font-semibold">Add manually</p>
              <p className="text-xs text-muted-foreground mt-0.5">Enter a single repo or package</p>
            </div>
            <div className="p-4 space-y-4 min-h-[220px] flex flex-col">
              <div className="space-y-1.5">
                <label htmlFor="entry-type" className="text-xs font-medium text-muted-foreground">Type</label>
                <Select
                  id="entry-type"
                  value={entryType}
                  onChange={(e) => setEntryType(e.target.value as PackageType)}
                >
                  {PACKAGE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </Select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="entry-name" className="text-xs font-medium text-muted-foreground">
                  {isGit ? 'Repository URL' : 'Package name'}
                </label>
                <Input
                  id="entry-name"
                  value={entryName}
                  onChange={(e) => setEntryName(e.target.value)}
                  placeholder={isGit ? 'https://github.com/org/repo' : 'express'}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddManual(); }}
                />
              </div>

              {!isGit && (
                <div className="space-y-1.5">
                  <label htmlFor="entry-version" className="text-xs font-medium text-muted-foreground">
                    Version <span className="font-normal">(optional)</span>
                  </label>
                  <Input
                    id="entry-version"
                    value={entryVersion}
                    onChange={(e) => setEntryVersion(e.target.value)}
                    placeholder="latest"
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddManual(); }}
                  />
                </div>
              )}

              {isGit && (
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={entryPrivate}
                    onChange={(e) => setEntryPrivate(e.target.checked)}
                    className="rounded border-border"
                  />
                  <span>Private repository</span>
                </label>
              )}

              <div className="flex-1" />

              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={handleAddManual}
                loading={manualLoading}
                disabled={manualLoading || !entryName.trim()}
              >
                <Plus className="w-4 h-4 mr-1.5" />
                Add to list
              </Button>
            </div>
          </Card>
        </div>

        {(loading || manualLoading) && (
          <p className="text-sm text-muted-foreground">Checking for duplicates...</p>
        )}

        {error && (
          <div className="flex items-start gap-2 text-destructive text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            {error}
          </div>
        )}

        {result && (
          <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-4 py-3">
            <CheckCircle className="w-4 h-4" />
            Queued <strong>{result.queued}</strong> for scanning.
            {result.skipped > 0 && (
              <> Skipped <strong>{result.skipped}</strong> (unchanged revision, already in queue, or invalid).</>
            )}
          </div>
        )}

        {hasEntries && !result && (
          <>
            <Card>
              <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold">{combinedPreview.total} entries ready</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {newCount > 0 && <span>{newCount} new</span>}
                    {newCount > 0 && existingCount > 0 && <span> · </span>}
                    {existingCount > 0 && (
                      <span className="text-amber-700">{existingCount} in database (will re-queue)</span>
                    )}
                    {newCount === 0 && existingCount === 0 && <span>No entries</span>}
                  </p>
                  {manualEntries.length > 0 && (
                    <p className="text-xs text-muted-foreground">{manualEntries.length} added manually</p>
                  )}
                </div>
                <Button onClick={handleImport} loading={importing} disabled={importing || !canQueue}>
                  Queue {combinedPreview.total} for scan
                </Button>
              </div>
              <PreviewList rows={combinedPreview.preview} />
            </Card>
            <p className="text-xs text-muted-foreground">
              * Git visibility defaults to <strong>Public</strong> and is auto-confirmed on clone. Registry packages are always public on the registry.
            </p>
          </>
        )}

        <Card>
          <button
            className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-accent/30 transition-colors rounded-lg"
            onClick={() => setFormatsOpen((v) => !v)}
            aria-expanded={formatsOpen}
          >
            <p className="text-sm font-semibold">Supported CSV formats</p>
            <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform', formatsOpen && 'rotate-180')} />
          </button>
          {formatsOpen && (
            <div className="px-4 pb-4 space-y-3 text-xs border-t border-border pt-3">
              <div>
                <p className="font-medium text-muted-foreground mb-1">Git repositories</p>
                <pre className="bg-muted rounded px-3 py-2 font-mono">{`https://github.com/org/repo
https://bitbucket.org/org/repo,private
https://internal.corp.com/team/service,private`}</pre>
              </div>
              <div>
                <p className="font-medium text-muted-foreground mb-1">npm packages</p>
                <pre className="bg-muted rounded px-3 py-2 font-mono">{`express,npm
lodash,npm,4.17.21`}</pre>
              </div>
              <div>
                <p className="font-medium text-muted-foreground mb-1">pip packages</p>
                <pre className="bg-muted rounded px-3 py-2 font-mono">{`requests,pip
django,pip,4.2.0`}</pre>
              </div>
              <div>
                <p className="font-medium text-muted-foreground mb-1">Cargo crates</p>
                <pre className="bg-muted rounded px-3 py-2 font-mono">{`serde,cargo
serde,cargo,1.0.0`}</pre>
              </div>
              <div>
                <p className="font-medium text-muted-foreground mb-1">Go modules</p>
                <pre className="bg-muted rounded px-3 py-2 font-mono">{`github.com/gin-gonic/gin,go
github.com/gin-gonic/gin,go,v1.9.1`}</pre>
              </div>
              <div>
                <p className="font-medium text-muted-foreground mb-1">Ruby gems</p>
                <pre className="bg-muted rounded px-3 py-2 font-mono">{`rails,gem
rails,gem,7.0.0`}</pre>
              </div>
              <p className="text-muted-foreground">
                For git repos: visibility defaults to <em>Public</em> and is auto-confirmed when the scanner clones (auth failure → marked Private).<br />
                For registry packages: source archives are downloaded from the public registry; the source repo URL is discovered from package metadata when available.
              </p>
            </div>
          )}
        </Card>
      </div>
    </Layout>
  );
}
