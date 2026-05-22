import { useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Upload, FileText, AlertCircle, CheckCircle, Lock, Globe, Package, ChevronDown } from 'lucide-react';
import { Layout } from '../../components/Layout.tsx';
import { Button } from '../../components/ui/Button.tsx';
import { Card } from '../../components/ui/Card.tsx';
import { Badge } from '../../components/ui/Badge.tsx';
import { api } from '../../lib/api.ts';
import { cn } from '../../lib/utils.ts';

interface PreviewRow {
  url: string;
  packageType: 'git' | 'npm' | 'pip';
  packageName?: string;
  packageVersion?: string;
  provider: string;
  isPrivate: boolean;
  exists: boolean;
  inQueue?: boolean;
}
interface PreviewResult { preview: PreviewRow[]; total: number; duplicates: number }

const PKG_COLORS: Record<string, string> = {
  npm: 'text-red-700 bg-red-50 border-red-200',
  pip: 'text-blue-700 bg-blue-50 border-blue-200',
  cargo: 'text-orange-700 bg-orange-50 border-orange-200',
  go: 'text-cyan-700 bg-cyan-50 border-cyan-200',
  gem: 'text-rose-700 bg-rose-50 border-rose-200',
  git: '',
};

export default function Import() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ queued: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [formatsOpen, setFormatsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const handleFile = async (f: File) => {
    setFile(f);
    setPreview(null);
    setResult(null);
    setError(null);
    setLoading(true);
    try {
      const res = await api.previewImport(f);
      setPreview(res as PreviewResult);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    if (!file) return;
    setImporting(true);
    setError(null);
    try {
      const res = await api.importRepos(file);
      setResult(res as { queued: number; skipped: number });
      qc.invalidateQueries({ queryKey: ['repos'] });
    } catch (err) {
      setError(String(err));
    } finally {
      setImporting(false);
    }
  };

  const newCount = preview?.preview.filter((r) => !r.exists).length ?? 0;

  return (
    <Layout title="Import" subtitle="Upload a CSV file with git repos or package names">
      <div className="max-w-2xl space-y-6">

        {/* Drop zone */}
        <div
          className={cn(
            'border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors',
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
          <input ref={inputRef} type="file" accept=".csv,.txt" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          <Upload className="mx-auto mb-3 text-muted-foreground w-8 h-8" />
          <p className="text-sm font-medium">Drop a CSV file here or click to browse</p>
          {file && <p className="text-xs text-primary mt-2 font-medium"><FileText className="inline w-3.5 h-3.5 mr-1" />{file.name}</p>}
        </div>

        {loading && <p className="text-sm text-muted-foreground">Checking for duplicates...</p>}

        {error && (
          <div className="flex items-start gap-2 text-destructive text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            {error}
          </div>
        )}

        {result && (
          <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-4 py-3">
            <CheckCircle className="w-4 h-4" />
            Queued <strong>{result.queued}</strong> entries for scanning. Skipped <strong>{result.skipped}</strong> duplicates.
          </div>
        )}

        {preview && !result && (
          <>
            <Card>
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{preview.total} entries found</p>
                  {preview.duplicates > 0 && (
                    <p className="text-xs text-amber-600">{preview.duplicates} already exist in the database</p>
                  )}
                </div>
                <Button onClick={handleImport} loading={importing} disabled={importing || newCount === 0}>
                  Import {newCount} New
                </Button>
              </div>
              <div className="max-h-80 overflow-y-auto">
                {preview.preview.map((row, i) => (
                  <div key={i} className={cn('px-4 py-2.5 flex items-center gap-2 text-sm border-b border-border last:border-0', row.exists && 'bg-amber-50/50')}>
                    {/* Package type badge */}
                    {row.packageType !== 'git' ? (
                      <span className={cn('flex items-center gap-1 text-xs border rounded px-1.5 py-0.5 shrink-0 font-medium', PKG_COLORS[row.packageType])}>
                        <Package className="w-3 h-3" /> {row.packageType.toUpperCase()}
                      </span>
                    ) : (
                      <Badge variant={row.provider === 'github' ? 'default' : row.provider === 'bitbucket' ? 'secondary' : 'outline'} className="shrink-0 text-xs">
                        {row.provider}
                      </Badge>
                    )}

                    {/* Name / URL */}
                    <span className="flex-1 font-mono text-xs truncate">
                      {row.packageType !== 'git' ? row.packageName : row.url}
                      {row.packageVersion && <span className="text-muted-foreground ml-1">@{row.packageVersion}</span>}
                    </span>

                    {/* Visibility (git only) */}
                    {row.packageType === 'git' && (
                      row.isPrivate ? (
                        <span className="flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 shrink-0" title="Declared private in CSV">
                          <Lock className="w-3 h-3" /> Private
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 shrink-0" title="Assumed public — confirmed when scanner clones">
                          <Globe className="w-3 h-3" /> Public*
                        </span>
                      )
                    )}

                    {row.inQueue && <Badge variant="secondary" className="shrink-0 text-xs">In queue</Badge>}
                    {row.exists && !row.inQueue && <Badge variant="warning" className="shrink-0 text-xs">Exists</Badge>}
                  </div>
                ))}
              </div>
            </Card>
            <p className="text-xs text-muted-foreground">
              * Git visibility defaults to <strong>Public</strong> and is auto-confirmed on clone. Registry packages are always public on the registry.
            </p>
          </>
        )}

        {/* Format reference — collapsible */}
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
