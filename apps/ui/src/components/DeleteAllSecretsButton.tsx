import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { Button } from './ui/Button.tsx';
import { ConfirmDialog } from './ui/Dialog.tsx';
import { api } from '../lib/api.ts';

type SecretDeleteScope = 'confirmed' | 'dropped';

interface DeleteAllSecretsButtonProps {
  scope: SecretDeleteScope;
  onDeleted?: () => void;
}

const COPY: Record<SecretDeleteScope, { title: string; description: string }> = {
  confirmed: {
    title: 'Delete all confirmed secrets?',
    description: 'Permanently delete all confirmed secret findings on this page. Dropped secrets are not affected.',
  },
  dropped: {
    title: 'Delete all dropped secrets?',
    description: 'Permanently delete all dropped secret findings on this page. Confirmed secrets are not affected.',
  },
};

/** Permanently delete all secret findings for the current page scope. */
export function DeleteAllSecretsButton({ scope, onDeleted }: DeleteAllSecretsButtonProps) {
  const qc = useQueryClient();
  const copy = COPY[scope];

  const clearAll = useMutation({
    mutationFn: () =>
      scope === 'confirmed' ? api.clearConfirmedSecrets() : api.clearDroppedSecrets(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['secrets'] });
      qc.invalidateQueries({ queryKey: ['dropped-secrets'] });
      onDeleted?.();
    },
  });

  return (
    <ConfirmDialog
      title={copy.title}
      description={copy.description}
      requireTyped="DELETE ALL"
      confirmText="Delete all"
      onConfirm={async () => { await clearAll.mutateAsync(); }}
    >
      {(open) => (
        <Button variant="destructive" size="sm" onClick={open} loading={clearAll.isPending}>
          <Trash2 className="w-3.5 h-3.5" /> Delete all
        </Button>
      )}
    </ConfirmDialog>
  );
}
