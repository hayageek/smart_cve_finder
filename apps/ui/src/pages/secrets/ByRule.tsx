import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { type ColumnDef } from '@tanstack/react-table';
import { Layout } from '../../components/Layout.tsx';
import { DataTable } from '../../components/ui/DataTable.tsx';
import { Input } from '../../components/ui/Input.tsx';
import { Tabs } from '../../components/ui/Tabs.tsx';
import { api } from '../../lib/api.ts';
import type { ApiSecretRuleCount } from '@secscan/shared';

function RuleTable({
  rows,
  isLoading,
  onRuleClick,
}: {
  rows: ApiSecretRuleCount[];
  isLoading: boolean;
  onRuleClick: (ruleId: string) => void;
}) {
  const columns = useMemo<ColumnDef<ApiSecretRuleCount>[]>(() => [
    {
      accessorKey: 'ruleId',
      header: 'Rule',
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.ruleId}</span>,
    },
    {
      accessorKey: 'count',
      header: 'Secrets',
      cell: ({ row }) => <span className="tabular-nums">{row.original.count.toLocaleString()}</span>,
    },
  ], []);

  if (isLoading) {
    return <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <DataTable
      columns={columns}
      data={rows}
      onRowClick={(row) => onRuleClick(row.ruleId)}
    />
  );
}

export default function SecretsByRule() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['secret-rule-stats'],
    queryFn: () => api.getSecretRuleStats(),
  });

  const filterRows = (rows: ApiSecretRuleCount[] | undefined) => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows ?? [];
    return (rows ?? []).filter((r) => r.ruleId.toLowerCase().includes(q));
  };

  const confirmedRows = filterRows(data?.confirmed);
  const droppedRows = filterRows(data?.dropped);
  const confirmedTotal = data?.confirmed.reduce((sum: number, r) => sum + r.count, 0) ?? 0;
  const droppedTotal = data?.dropped.reduce((sum: number, r) => sum + r.count, 0) ?? 0;

  return (
    <Layout
      title="Secrets by Rule"
      subtitle={`${confirmedTotal.toLocaleString()} confirmed · ${droppedTotal.toLocaleString()} dropped`}
    >
      <div className="space-y-4">
        <Input
          placeholder="Filter by rule…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-md"
        />

        <Tabs
          tabs={[
            {
              id: 'confirmed',
              label: `Confirmed (${confirmedRows.length})`,
              content: (
                <RuleTable
                  rows={confirmedRows}
                  isLoading={isLoading}
                  onRuleClick={(ruleId) =>
                    navigate(`/secrets/confirmed?ruleId=${encodeURIComponent(ruleId)}`)
                  }
                />
              ),
            },
            {
              id: 'dropped',
              label: `Dropped (${droppedRows.length})`,
              content: (
                <RuleTable
                  rows={droppedRows}
                  isLoading={isLoading}
                  onRuleClick={(ruleId) =>
                    navigate(`/secrets/dropped?ruleId=${encodeURIComponent(ruleId)}`)
                  }
                />
              ),
            },
          ]}
        />
      </div>
    </Layout>
  );
}
