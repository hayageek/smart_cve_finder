import { useState } from 'react';
import { Copy, Check, Trash2 } from 'lucide-react';
import { Modal, VULN_DETAIL_MODAL_SIZE_KEY, ConfirmDialog } from './ui/Dialog.tsx';
import { Button } from './ui/Button.tsx';
import { SeverityBadge, Badge } from './ui/Badge.tsx';
import { RepoUrlLink } from './RepoUrlLink.tsx';
import type { ApiVulnerability } from '@secscan/shared';

interface DroppedVulnDetailProps {
  vuln: ApiVulnerability;
  onClose: () => void;
  onPromote?: () => void;
  promoteLoading?: boolean;
  onDelete?: () => void | Promise<void>;
  deleteLoading?: boolean;
}

export function DroppedVulnDetail({ vuln, onClose, onPromote, promoteLoading, onDelete, deleteLoading }: DroppedVulnDetailProps) {
  const [copied, setCopied] = useState(false);
  const meta = (vuln.metadataJson ?? {}) as {
    dataflow_steps?: string[];
    confidence_reasons?: string[];
    trust_boundary?: string;
    requires_auth?: string;
    requires_misconfig?: boolean;
    source_location?: string;
    sink_location?: string;
    confidence?: string;
    vulnerability_type?: string;
  };
  const hasMetaContext = !!(meta.requires_auth || meta.requires_misconfig != null || meta.trust_boundary);

  const copyFindingId = async () => {
    try {
      await navigator.clipboard.writeText(vuln.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      alert('Could not copy to clipboard');
    }
  };

  return (
    <Modal
      open={true}
      title="Dropped Finding Detail"
      onClose={onClose}
      resizable
      sizeStorageKey={VULN_DETAIL_MODAL_SIZE_KEY}
    >
      <div className="space-y-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <SeverityBadge severity={vuln.severity} />
            <span className="font-mono text-xs text-muted-foreground">{vuln.cwe}</span>
            {vuln.vulnType && <Badge variant="outline">{vuln.vulnType}</Badge>}
            {vuln.cvssScore !== null && <Badge variant="outline">CVSS {vuln.cvssScore}</Badge>}
          </div>
          <Button size="sm" variant="outline" onClick={copyFindingId} title="Copy finding ID to clipboard">
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy ID'}
          </Button>
        </div>

        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 space-y-2">
          <p className="text-xs font-medium text-amber-900">Why this was dropped</p>
          {vuln.dropReason && (
            <div>
              <p className="text-xs text-muted-foreground">Drop Reason</p>
              <Badge variant="secondary" className="mt-0.5">{vuln.dropReason}</Badge>
            </div>
          )}
          {vuln.dropEvidence && (
            <div>
              <p className="text-xs text-muted-foreground">Drop Evidence</p>
              <p className="text-xs break-words whitespace-pre-wrap">{vuln.dropEvidence}</p>
            </div>
          )}
          {!vuln.dropReason && !vuln.dropEvidence && (
            <p className="text-xs text-muted-foreground">No drop reason recorded.</p>
          )}
        </div>

        <div>
          <p className="text-xs text-muted-foreground">Finding ID</p>
          <p className="font-mono text-xs break-all">{vuln.id}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Repo</p>
          <RepoUrlLink repoUrl={vuln.repoUrl} fullWidth className="text-sm" />
        </div>
        {vuln.packageRepoUrl && (
          <div>
            <p className="text-xs text-muted-foreground">Source Repo URL</p>
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
            <p className="text-xs text-muted-foreground">Package Archive URL</p>
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
          <p className="font-mono text-xs break-all">
            {vuln.path}:{vuln.lineStart}{vuln.lineEnd ? `–${vuln.lineEnd}` : ''}
          </p>
        </div>
        {vuln.message && (
          <div>
            <p className="text-xs text-muted-foreground">Message</p>
            <p className="text-xs break-words">{vuln.message}</p>
          </div>
        )}
        {meta.source_location && (
          <div>
            <p className="text-xs text-muted-foreground">Source → Sink</p>
            <p className="font-mono text-xs text-amber-700 break-all">{meta.source_location}</p>
            <p className="font-mono text-xs mt-0.5">↓</p>
            <p className="font-mono text-xs text-red-700 break-all">{meta.sink_location}</p>
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

        {(onPromote || onDelete) && (
          <div className="border-t border-border pt-3 flex flex-col gap-2">
            {onPromote && (
              <Button size="sm" className="w-full" loading={promoteLoading} onClick={onPromote}>
                Promote to Confirmed
              </Button>
            )}
            {onDelete && (
              <ConfirmDialog
                title="Delete Dropped Finding"
                description="Permanently remove this dropped finding?"
                confirmText="Delete"
                onConfirm={async () => { await onDelete?.(); }}
              >
                {(open) => (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="w-full"
                    loading={deleteLoading}
                    onClick={open}
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </Button>
                )}
              </ConfirmDialog>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
