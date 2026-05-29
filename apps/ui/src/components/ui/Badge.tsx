import { CheckCircle2, CircleDashed, Loader2, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils.ts';
import { Tooltip } from './Tooltip.tsx';

type Variant = 'default' | 'success' | 'warning' | 'destructive' | 'outline' | 'secondary';

const variants: Record<Variant, string> = {
  default: 'bg-primary text-primary-foreground',
  success: 'bg-emerald-100 text-emerald-800',
  warning: 'bg-amber-100 text-amber-800',
  destructive: 'bg-red-100 text-red-700',
  outline: 'border border-border text-foreground',
  secondary: 'bg-muted text-muted-foreground',
};

interface BadgeProps {
  children: React.ReactNode;
  variant?: Variant;
  className?: string;
}

export function Badge({ children, variant = 'default', className }: BadgeProps) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', variants[variant], className)}>
      {children}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, Variant> = {
    CRITICAL: 'destructive',
    HIGH: 'warning',
    MEDIUM: 'secondary',
    LOW: 'outline',
  };
  return <Badge variant={map[severity] ?? 'outline'}>{severity}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, Variant> = {
    done: 'success',
    failed: 'destructive',
    scanning: 'warning',
    cloning: 'warning',
    exploiting: 'warning',
    queued: 'secondary',
    pending: 'secondary',
    skipped: 'outline',
    generating: 'warning',
  };
  return <Badge variant={map[status] ?? 'outline'}>{status}</Badge>;
}

function exploitStatusConfig(status: string | null | undefined) {
  switch (status) {
    case 'done':
      return { Icon: CheckCircle2, label: 'Exploitable', className: 'text-emerald-600' };
    case 'pending':
    case 'generating':
      return { Icon: Loader2, label: 'In progress', className: 'text-amber-600 animate-spin' };
    case 'failed':
      return { Icon: XCircle, label: 'Failed', className: 'text-red-600' };
    default:
      return { Icon: CircleDashed, label: 'Not tried', className: 'text-muted-foreground' };
  }
}

export function ExploitStatusIcon({ status }: { status: string | null | undefined }) {
  const { Icon, label, className } = exploitStatusConfig(status);
  return (
    <Tooltip content={label}>
      <Icon className={cn('w-4 h-4', className)} aria-label={label} />
    </Tooltip>
  );
}
