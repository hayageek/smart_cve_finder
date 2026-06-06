import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button.tsx';
import { ConfirmDialog } from './ui/Dialog.tsx';
import { api } from '../lib/api.ts';

export function DeleteSameExtensionSecretsButton({
  extension,
  onDeleted,
}: {
  extension: string;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['secrets-by-extension-count', extension],
    queryFn: () => api.countSecretsByExtension(extension),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteSecretsByExtension(extension),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['secrets'] });
      qc.invalidateQueries({ queryKey: ['dropped-secrets'] });
      qc.invalidateQueries({ queryKey: ['secrets-by-extension-count', extension] });
      onDeleted();
    },
  });

  const count = data?.count ?? 0;
  if (isLoading || count === 0) return null;

  return (
    <ConfirmDialog
      title="Delete all findings with this extension?"
      description={`Permanently delete ${count} secret finding(s) in files ending with "${extension}" across all repos? This cannot be undone.`}
      confirmText="Delete all"
      onConfirm={async () => { await deleteMutation.mutateAsync(); }}
    >
      {(open) => (
        <Button
          size="sm"
          variant="destructive"
          onClick={open}
          loading={deleteMutation.isPending}
        >
          Delete same extension ({extension}, {count})
        </Button>
      )}
    </ConfirmDialog>
  );
}
