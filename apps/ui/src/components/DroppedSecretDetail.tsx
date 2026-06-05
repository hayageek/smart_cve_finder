import { Modal } from './ui/Dialog.tsx';
import { Button } from './ui/Button.tsx';
import { Badge, SeverityBadge } from './ui/Badge.tsx';
import { RepoUrlLink } from './RepoUrlLink.tsx';
import { formatFileLine } from '../lib/utils.ts';
import type { ApiSecret } from '@secscan/shared';

export function DroppedSecretDetail({
  secret,
  onClose,
  onPromote,
  promoteLoading,
}: {
  secret: ApiSecret;
  onClose: () => void;
  onPromote?: () => void;
  promoteLoading?: boolean;
}) {
  return (
    <Modal open={true} title="Dropped Secret" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <SeverityBadge severity={secret.severity} />
          <Badge variant="outline">{secret.dropReason ?? 'dropped'}</Badge>
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
          <p className="text-xs text-muted-foreground">Redacted preview</p>
          <p className="font-mono text-xs">{secret.redactedValue ?? '—'}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Repo</p>
          <RepoUrlLink repoUrl={secret.repoUrl} fullWidth className="text-sm" />
        </div>
        {secret.dropEvidence && (
          <div>
            <p className="text-xs text-muted-foreground">Evidence</p>
            <p className="text-muted-foreground">{secret.dropEvidence}</p>
          </div>
        )}
        {onPromote && (
          <Button size="sm" loading={promoteLoading} onClick={onPromote}>
            Promote to confirmed
          </Button>
        )}
      </div>
    </Modal>
  );
}
