import { FINDING_ORIGIN_LABELS, type FindingOrigin } from '@secscan/shared';
import { Badge } from './ui/Badge.tsx';

export function findingOriginOf(metadataJson: unknown): string | null {
  if (!metadataJson || typeof metadataJson !== 'object') return null;
  const value = (metadataJson as { finding_origin?: unknown }).finding_origin;
  return typeof value === 'string' && value.trim() ? value : null;
}

export function findingOriginLabel(origin: string | null | undefined): string {
  if (!origin) return '—';
  return FINDING_ORIGIN_LABELS[origin as FindingOrigin] ?? origin;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    const parts = value.map((item) => String(item)).filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  return String(value);
}

function Field({ label, value }: { label: string; value: unknown }) {
  const text = textOf(value);
  if (!text) return null;
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xs break-words whitespace-pre-wrap">{text}</p>
    </div>
  );
}

function MetaBlock({
  title,
  record,
  fields,
}: {
  title: string;
  record: Record<string, unknown>;
  fields: { key: string; label: string }[];
}) {
  const visible = fields.some((field) => textOf(record[field.key]));
  if (!visible) return null;
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {fields.map((field) => (
        <Field key={field.key} label={field.label} value={record[field.key]} />
      ))}
    </div>
  );
}

const VARIANT_FIELDS = [
  { key: 'origin', label: 'Origin' },
  { key: 'related_cves', label: 'Related CVEs' },
  { key: 'fix_ref', label: 'Fix ref' },
  { key: 'original_location', label: 'Original location' },
  { key: 'bypass_rationale', label: 'Bypass rationale' },
  { key: 'variant_sweep_signature', label: 'Variant sweep signature' },
];

const SBOM_FIELDS = [
  { key: 'package', label: 'Package' },
  { key: 'version', label: 'Version' },
  { key: 'ecosystem', label: 'Ecosystem' },
  { key: 'upstream_cve', label: 'Upstream CVE' },
  { key: 'osv_id', label: 'OSV / GHSA' },
  { key: 'fixed_version', label: 'Fixed version' },
  { key: 'cvss_score', label: 'CVSS score' },
  { key: 'cvss_vector', label: 'CVSS vector' },
  { key: 'vulnerable_symbol', label: 'Vulnerable symbol' },
  { key: 'dependency_kind', label: 'Dependency kind' },
  { key: 'dependency_path', label: 'Dependency path' },
  { key: 'introduced_by', label: 'Introduced by' },
  { key: 'reachable', label: 'Reachable' },
  { key: 'reachability_evidence', label: 'Reachability evidence' },
  { key: 'remediation', label: 'Remediation' },
];

export function FindingOriginBadge({ metadataJson }: { metadataJson: unknown }) {
  const origin = findingOriginOf(metadataJson);
  if (!origin) return null;
  return <Badge variant="outline">{findingOriginLabel(origin)}</Badge>;
}

/** Variant and SBOM blocks from schema v1.1. Each skill emits at most one. */
export function FindingSkillSections({ metadataJson }: { metadataJson: unknown }) {
  const meta = asRecord(metadataJson);
  if (!meta) return null;
  const variant = asRecord(meta.variant);
  const sbom = asRecord(meta.sbom);
  if (!variant && !sbom) return null;
  return (
    <>
      {variant && <MetaBlock title="Variant" record={variant} fields={VARIANT_FIELDS} />}
      {sbom && <MetaBlock title="SBOM" record={sbom} fields={SBOM_FIELDS} />}
    </>
  );
}
