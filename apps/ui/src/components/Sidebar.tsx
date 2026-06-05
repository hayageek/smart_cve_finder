import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Upload, List, Activity, Clock, ShieldAlert,
  ShieldOff, KeyRound, Zap, Settings, Server, ChevronRight
} from 'lucide-react';
import { cn } from '../lib/utils.ts';
import { useState } from 'react';

interface NavItem {
  label: string;
  icon: React.ElementType;
  to?: string;
  children?: { label: string; to: string }[];
}

const nav: NavItem[] = [
  { label: 'Dashboard', icon: LayoutDashboard, to: '/' },
  {
    label: 'Repositories',
    icon: List,
    children: [
      { label: 'Import', to: '/repos/import' },
      { label: 'All Repos', to: '/repos' },
    ],
  },
  {
    label: 'Scans',
    icon: Activity,
    children: [
      { label: 'Queue', to: '/scans/queue' },
      { label: 'History', to: '/scans/history' },
    ],
  },
  {
    label: 'Vulnerabilities',
    icon: ShieldAlert,
    children: [
      { label: 'Confirmed', to: '/vulns/confirmed' },
      { label: 'Dropped', to: '/vulns/dropped' },
    ],
  },
  {
    label: 'Secrets',
    icon: KeyRound,
    children: [
      { label: 'Confirmed', to: '/secrets/confirmed' },
      { label: 'Dropped', to: '/secrets/dropped' },
    ],
  },
  { label: 'Exploits', icon: Zap, to: '/exploits' },
  { label: 'Workers', icon: Server, to: '/workers' },
  { label: 'Settings', icon: Settings, to: '/settings' },
];

function NavGroup({ item }: { item: NavItem }) {
  const location = useLocation();
  const isChildActive = item.children?.some((c) => location.pathname.startsWith(c.to));
  const [open, setOpen] = useState(isChildActive ?? false);

  if (item.to) {
    return (
      <NavLink
        to={item.to}
        end={item.to === '/'}
        className={({ isActive }) =>
          cn(
            'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
            isActive
              ? 'bg-accent text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )
        }
      >
        <item.icon className="w-4 h-4 flex-shrink-0" />
        {item.label}
      </NavLink>
    );
  }

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'w-full flex items-center justify-between gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
          isChildActive
            ? 'text-primary'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <span className="flex items-center gap-2.5">
          <item.icon className="w-4 h-4 flex-shrink-0" />
          {item.label}
        </span>
        <ChevronRight className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && item.children && (
        <div className="ml-6 mt-0.5 flex flex-col gap-0.5">
          {item.children.map((child) => (
            <NavLink
              key={child.to}
              to={child.to}
              className={({ isActive }) =>
                cn(
                  'px-3 py-1.5 rounded-md text-sm transition-colors',
                  isActive
                    ? 'bg-accent text-primary font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )
              }
            >
              {child.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="w-56 flex-shrink-0 border-r border-border bg-card h-screen sticky top-0 flex flex-col">
      <div className="px-4 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-primary" />
          <span className="font-semibold text-sm text-foreground">SmartSAST</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">Security Repository Scanner</p>
      </div>
      <nav className="flex-1 px-2 py-3 flex flex-col gap-0.5 overflow-y-auto">
        {nav.map((item) => (
          <NavGroup key={item.label} item={item} />
        ))}
      </nav>
    </aside>
  );
}
