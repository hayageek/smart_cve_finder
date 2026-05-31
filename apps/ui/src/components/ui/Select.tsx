import { cn } from '../../lib/utils.ts';
import type { SelectHTMLAttributes } from 'react';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Tighter padding and text for dense filter toolbars */
  density?: 'default' | 'compact';
}

export function Select({ className, density = 'default', children, ...props }: SelectProps) {
  return (
    <select
      className={cn(
        'rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50',
        density === 'compact'
          ? 'h-8 shrink-0 px-2 py-0 text-xs w-auto max-w-[7.5rem]'
          : 'flex h-9 px-3 py-1 text-sm',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
