import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button.tsx';
import { ConfirmDialog } from './ui/Dialog.tsx';
import { api } from '../lib/api.ts';
import { truncate } from '../lib/utils.ts';

export function DeleteSameFilenameSecretsButton({
  filename,
  onDeleted,
}: {
  filename: string;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['secrets-by-filename-count', filename],
    queryFn: () => api.countSecretsByFilename(filename),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteSecretsByFilename(filename),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['secrets'] });
      qc.invalidateQueries({ queryKey: ['dropped-secrets'] });
      qc.invalidateQueries({ queryKey: ['secrets-by-filename-count', filename] });
      onDeleted();
    },
  });

  const count = data?.count ?? 0;
  if (isLoading || count === 0) return null;

  const label = truncate(filename, 24);

  return (
    <ConfirmDialog
      title="Delete all findings in this file?"
      description={`Permanently delete ${count} secret finding(s) in any path ending with "${filename}" across all repos? This cannot be undone.`}
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
          Delete same file ({label}, {count})
        </Button>
      )}
    </ConfirmDialog>
  );
}
