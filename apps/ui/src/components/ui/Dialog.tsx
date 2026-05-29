import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button.tsx';
import { Input } from './Input.tsx';
import { cn } from '../../lib/utils.ts';

export const VULN_DETAIL_MODAL_SIZE_KEY = 'secscan:vuln-detail-modal-size';
export const REPORT_VIEWER_MODAL_SIZE_KEY = 'secscan:report-viewer-modal-size';

export interface ModalSize {
  width: number;
  height: number;
}

interface ModalSizeConstraints {
  minWidth?: number;
  minHeight?: number;
}

const VIEWPORT_PADDING = 32;

function clampModalSize(
  size: ModalSize,
  constraints: ModalSizeConstraints = {},
): ModalSize {
  const minWidth = constraints.minWidth ?? 420;
  const minHeight = constraints.minHeight ?? 320;
  const maxWidth = Math.max(minWidth, window.innerWidth - VIEWPORT_PADDING);
  const maxHeight = Math.max(minHeight, window.innerHeight - VIEWPORT_PADDING);
  return {
    width: Math.min(maxWidth, Math.max(minWidth, Math.round(size.width))),
    height: Math.min(maxHeight, Math.max(minHeight, Math.round(size.height))),
  };
}

function loadStoredModalSize(
  storageKey: string,
  defaultSize: ModalSize,
  constraints?: ModalSizeConstraints,
): ModalSize {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return clampModalSize(defaultSize, constraints);
    const parsed = JSON.parse(raw) as Partial<ModalSize>;
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') {
      return clampModalSize(defaultSize, constraints);
    }
    return clampModalSize({ width: parsed.width, height: parsed.height }, constraints);
  } catch {
    return clampModalSize(defaultSize, constraints);
  }
}

function usePersistedModalSize(
  storageKey: string,
  defaultSize: ModalSize,
  enabled: boolean,
  constraints?: ModalSizeConstraints,
) {
  const [size, setSize] = useState<ModalSize>(() =>
    enabled ? loadStoredModalSize(storageKey, defaultSize, constraints) : defaultSize,
  );

  useEffect(() => {
    if (!enabled) return;
    setSize(loadStoredModalSize(storageKey, defaultSize, constraints));
  }, [storageKey, enabled, defaultSize.width, defaultSize.height, constraints]);

  useEffect(() => {
    if (!enabled) return;
    const onResize = () => {
      setSize((current) => clampModalSize(current, constraints));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [enabled, constraints]);

  const persistSize = useCallback((next: ModalSize) => {
    const clamped = clampModalSize(next, constraints);
    setSize(clamped);
    try {
      localStorage.setItem(storageKey, JSON.stringify(clamped));
    } catch {
      // ignore quota / private mode errors
    }
  }, [storageKey, constraints]);

  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = size;

    const onMove = (moveEvent: MouseEvent) => {
      setSize(clampModalSize({
        width: startSize.width + (moveEvent.clientX - startX),
        height: startSize.height + (moveEvent.clientY - startY),
      }, constraints));
    };

    const onUp = (upEvent: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistSize({
        width: startSize.width + (upEvent.clientX - startX),
        height: startSize.height + (upEvent.clientY - startY),
      });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [size, persistSize, constraints]);

  return { size, startResize };
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
  /** Raise above another open modal (e.g. report preview over vuln detail). */
  stacked?: boolean;
  /** Enable drag-to-resize with size persisted in localStorage. */
  resizable?: boolean;
  sizeStorageKey?: string;
  defaultSize?: ModalSize;
  sizeConstraints?: ModalSizeConstraints;
}

/** Centered overlay dialog for detail views. */
export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  stacked,
  resizable = false,
  sizeStorageKey,
  defaultSize = { width: 768, height: 560 },
  sizeConstraints,
}: ModalProps) {
  const { size, startResize } = usePersistedModalSize(
    sizeStorageKey ?? VULN_DETAIL_MODAL_SIZE_KEY,
    defaultSize,
    resizable && !!sizeStorageKey,
    sizeConstraints,
  );

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
        style={resizable ? { width: size.width, height: size.height } : undefined}
        className={cn(
          'relative bg-card border border-border rounded-lg shadow-lg flex flex-col mx-4 z-10',
          resizable ? 'max-w-none max-h-none min-h-0' : 'w-full max-w-lg max-h-[85vh]',
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
        <div className={cn('overflow-y-auto px-5 py-4', resizable && 'flex flex-col flex-1 min-h-0')}>{children}</div>
        {resizable && (
          <button
            type="button"
            aria-label="Resize dialog"
            onMouseDown={startResize}
            className="absolute bottom-0 right-0 z-10 h-5 w-5 cursor-se-resize touch-none"
          >
            <span
              aria-hidden
              className="absolute bottom-1.5 right-1.5 block h-2.5 w-2.5 border-r-2 border-b-2 border-muted-foreground/60"
            />
          </button>
        )}
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
