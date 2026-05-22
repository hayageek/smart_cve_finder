import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type RowSelectionState,
} from '@tanstack/react-table';
import { cn } from '../../lib/utils.ts';

interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  onRowClick?: (row: T) => void;
  className?: string;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  getRowId?: (row: T, index: number) => string;
}

export function DataTable<T>({
  data,
  columns,
  onRowClick,
  className,
  rowSelection,
  onRowSelectionChange,
  getRowId,
}: DataTableProps<T>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    ...(rowSelection !== undefined
      ? {
          state: { rowSelection },
          onRowSelectionChange,
          enableRowSelection: true,
          getRowId,
        }
      : {}),
  });

  return (
    <div className={cn('w-full overflow-auto rounded-md border border-border', className)}>
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((header) => (
                <th key={header.id} className="px-3 py-2.5 text-left font-medium text-muted-foreground whitespace-nowrap">
                  {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-muted-foreground">
                No results
              </td>
            </tr>
          ) : (
            table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => onRowClick?.(row.original)}
                className={cn(
                  'border-t border-border transition-colors',
                  onRowClick && 'cursor-pointer hover:bg-accent/50',
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2.5 align-middle">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

interface PaginationProps {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
  total: number;
  pageSize: number;
}

export function Pagination({ page, totalPages, onPage, total, pageSize }: PaginationProps) {
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between mt-3 text-sm text-muted-foreground">
      <span>{total > 0 ? `${from}–${to} of ${total}` : '0 results'}</span>
      <div className="flex gap-1">
        <button onClick={() => onPage(1)} disabled={page === 1} className="px-2 py-1 rounded border border-border disabled:opacity-40 hover:bg-accent">«</button>
        <button onClick={() => onPage(page - 1)} disabled={page === 1} className="px-2 py-1 rounded border border-border disabled:opacity-40 hover:bg-accent">‹</button>
        <span className="px-3 py-1 text-foreground font-medium">{page} / {totalPages || 1}</span>
        <button onClick={() => onPage(page + 1)} disabled={page >= totalPages} className="px-2 py-1 rounded border border-border disabled:opacity-40 hover:bg-accent">›</button>
        <button onClick={() => onPage(totalPages)} disabled={page >= totalPages} className="px-2 py-1 rounded border border-border disabled:opacity-40 hover:bg-accent">»</button>
      </div>
    </div>
  );
}
