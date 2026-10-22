import { useEffect } from 'react';
import { registerToastBridge, useToast } from './ui/Toast.tsx';

/** Registers toast helpers for React Query mutation cache. */
export function ToastBridge() {
  const toast = useToast();
  useEffect(() => {
    registerToastBridge(toast);
    return () => registerToastBridge(null);
  }, [toast]);
  return null;
}
