import { MutationCache, QueryClient } from '@tanstack/react-query';
import { getToastBridge } from '../components/ui/Toast.tsx';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** When true, do not show success/error toasts for this mutation. */
      silent?: boolean;
      successMessage?: string;
      errorMessage?: string;
    };
  }
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  return fallback;
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 2 },
    },
    mutationCache: new MutationCache({
      onSuccess: (_data, _variables, _context, mutation) => {
        if (mutation.meta?.silent) return;
        const toast = getToastBridge();
        if (!toast) return;
        toast.success(mutation.meta?.successMessage ?? 'Action completed successfully');
      },
      onError: (err, _variables, _context, mutation) => {
        if (mutation.meta?.silent) return;
        const toast = getToastBridge();
        if (!toast) return;
        const msg = mutation.meta?.errorMessage ?? errorMessage(err, 'Request failed');
        toast.error('Action failed', msg);
      },
    }),
  });
}
