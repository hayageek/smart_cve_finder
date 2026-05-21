import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button.tsx';
import { Input } from './Input.tsx';
import { cn } from '../../lib/utils.ts';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
  /** Raise above another open modal (e.g. report preview over vuln detail). */
  stacked?: boolean;
}

/** Centered overlay dialog for detail views. */
export function Modal({ open, onClose, title, children, className, stacked }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={cn('fixed inset-0 flex items-center justify-center p-4', stacked ? 'z-[60]' : 'z-50')}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={cn(
          'relative bg-card border border-border rounded-lg shadow-lg w-full max-w-lg max-h-[85vh] flex flex-col mx-4 z-10',
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 id="modal-title" className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground rounded p-1"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmText?: string;
  requireTyped?: string;
  onConfirm: () => void | Promise<void>;
  children: (open: () => void) => React.ReactNode;
}

export function ConfirmDialog({ title, description, confirmText = 'Confirm', requireTyped, onConfirm, children }: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [loading, setLoading] = useState(false);

  const canConfirm = requireTyped ? typed === requireTyped : true;

  const handleConfirm = async () => {
    setLoading(true);
    try { await onConfirm(); } finally {
      setLoading(false);
      setOpen(false);
      setTyped('');
    }
  };

  return (
    <>
      {children(() => setOpen(true))}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="relative bg-card border border-border rounded-lg p-6 w-full max-w-sm mx-4">
            <h2 className="text-base font-semibold mb-2">{title}</h2>
            <p className="text-sm text-muted-foreground mb-4">{description}</p>
            {requireTyped && (
              <div className="mb-4">
                <p className="text-xs text-muted-foreground mb-1.5">Type <strong>{requireTyped}</strong> to confirm</p>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={requireTyped} />
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="destructive" size="sm" disabled={!canConfirm} loading={loading} onClick={handleConfirm}>
                {confirmText}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
