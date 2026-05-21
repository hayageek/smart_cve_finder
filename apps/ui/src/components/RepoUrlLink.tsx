import { cn } from '../lib/utils.ts';

interface RepoUrlLinkProps {
  repoUrl: string;
  className?: string;
}

/** Renders a repo URL as a link when it is http(s); otherwise plain text. */
export function RepoUrlLink({ repoUrl, className }: RepoUrlLinkProps) {
  const label = repoUrl.replace(/^https?:\/\//, '');
  const href = /^https?:\/\//i.test(repoUrl) ? repoUrl : null;
  const base = cn('text-xs text-muted-foreground truncate max-w-32 block', className);

  if (!href) {
    return <span className={base}>{label}</span>;
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(base, 'hover:text-primary hover:underline')}
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </a>
  );
}
