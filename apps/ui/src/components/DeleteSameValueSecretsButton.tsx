import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button.tsx';
import { ConfirmDialog } from './ui/Dialog.tsx';
import { api } from '../lib/api.ts';

export function DeleteSameValueSecretsButton({
  value,
  onDeleted,
}: {
  value: string;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['secrets-by-value-count', value],
    queryFn: () => api.countSecretsByValue(value),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteSecretsByValue(value),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['secrets'] });
      qc.invalidateQueries({ queryKey: ['dropped-secrets'] });
      qc.invalidateQueries({ queryKey: ['secrets-by-value-count', value] });
      onDeleted();
    },
  });

  const count = data?.count ?? 0;
  if (isLoading || count === 0) return null;

  return (
    <ConfirmDialog
      title="Delete all findings with this value?"
      description={`Permanently delete ${count} secret finding(s) with this exact value across all repos and packages? This cannot be undone.`}
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
          Delete same value ({count})
        </Button>
      )}
    </ConfirmDialog>
  );
}
