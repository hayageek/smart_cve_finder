import { CVE_HUNT_SKILLS, type CveHuntSkill } from '@secscan/shared';
import { cn } from '../lib/utils.ts';

const SKILL_COPY: Record<CveHuntSkill, { label: string; description: string }> = {
  'cve-ai-finder': {
    label: 'cve-ai-finder',
    description: 'Source-to-sink hunt in first-party code',
  },
  'cve-variant-hunter': {
    label: 'cve-variant-hunter',
    description: 'Incomplete fixes, patch bypasses, and variants of known CVEs',
  },
  'sbom-vuln-mapper': {
    label: 'sbom-vuln-mapper',
    description: 'Reachable CVEs in direct and transitive dependencies',
  },
};

export function CveSkillPicker({
  value,
  onChange,
  compact = false,
}: {
  value: CveHuntSkill[];
  onChange: (next: CveHuntSkill[]) => void;
  compact?: boolean;
}) {
  const selected = new Set(value);
  const allSelected = CVE_HUNT_SKILLS.every((skill) => selected.has(skill));

  const toggle = (skill: CveHuntSkill) => {
    if (selected.has(skill)) {
      if (selected.size === 1) return;
      onChange(value.filter((item) => item !== skill));
      return;
    }
    onChange(CVE_HUNT_SKILLS.filter((item) => item === skill || selected.has(item)));
  };

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => onChange([...CVE_HUNT_SKILLS])}
        className={cn(
          'px-3 py-2 rounded-md border text-left text-sm transition-colors',
          compact ? 'min-w-[4.5rem]' : 'min-w-[88px]',
          allSelected
            ? 'border-primary bg-accent text-primary font-medium'
            : 'border-border hover:bg-accent/50 text-muted-foreground',
        )}
      >
        <span className="block font-medium">All</span>
        {!compact && (
          <span className="block text-xs mt-0.5 opacity-80">Run every CVE skill</span>
        )}
      </button>
      {CVE_HUNT_SKILLS.map((skill) => {
        const copy = SKILL_COPY[skill];
        const on = selected.has(skill);
        return (
          <button
            key={skill}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(skill)}
            className={cn(
              'px-3 py-2 rounded-md border text-left text-sm transition-colors',
              compact ? 'max-w-[11rem]' : 'min-w-[180px] max-w-xs',
              on
                ? 'border-primary bg-accent text-primary font-medium'
                : 'border-border hover:bg-accent/50 text-muted-foreground',
            )}
          >
            <span className={cn('block font-medium font-mono', compact ? 'text-[11px]' : 'text-xs')}>{copy.label}</span>
            {!compact && (
              <span className="block text-xs mt-0.5 opacity-80">{copy.description}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
