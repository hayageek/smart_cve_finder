import { cn } from '../lib/utils.ts';

interface RepoUrlLinkProps {
  repoUrl: string;
  className?: string;
  /** @deprecated use display="full" */
  fullWidth?: boolean;
  /** compact: narrow truncate (default). table: wider cell with wrap. full: complete URL. */
  display?: 'compact' | 'table' | 'full';
}

/** Renders a repo URL as a link when it is http(s); otherwise plain text. */
export function RepoUrlLink({ repoUrl, className, fullWidth = false, display }: RepoUrlLinkProps) {
  const mode = display ?? (fullWidth ? 'full' : 'compact');
  const label = mode === 'full' ? repoUrl : repoUrl.replace(/^https?:\/\//, '');
  const href = /^https?:\/\//i.test(repoUrl) ? repoUrl : null;
  const base = cn(
    'text-xs text-muted-foreground block',
    mode === 'full' && 'break-all whitespace-normal font-mono',
    mode === 'table' && 'min-w-[11rem] max-w-sm break-all leading-snug line-clamp-2',
    mode === 'compact' && 'truncate max-w-32',
    className,
  );

  if (!href) {
    return <span className={base} title={repoUrl}>{label}</span>;
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(base, 'hover:text-primary hover:underline')}
      onClick={(e) => e.stopPropagation()}
      title={repoUrl}
    >
      {label}
    </a>
  );
}
