import * as React from 'react';
import { TableCell, TableSortLabel } from '@mui/material';

/**
 * Every table the office reads answers "in what order?" — and the honest
 * answer is that the answer belongs to the reader, not to the query.
 *
 * Two kinds, and the difference is pagination: a page the server slices
 * (due queue, invoice book, billing queue) must sort server-side, because
 * sorting page 3 by balance after fetching page 3 in date order sorts
 * fifteen rows and calls the other seven hundred-and-eighty-five honest.
 * A page the server hands over whole (receivables, bids, price list,
 * accounts) sorts right here, in memory, for free.
 *
 * `SortHeader` is the shared face of both: same arrow, same click-to-toggle,
 * whichever engine sits behind it.
 */

export type SortDir = 'asc' | 'desc';

export interface SortState {
  field: string;
  dir: SortDir;
}

/** Click on a new column starts ascending; clicking the same column flips. */
export const nextSort = (current: SortState, field: string): SortState =>
  current.field === field
    ? { field, dir: current.dir === 'asc' ? 'desc' : 'asc' }
    : { field, dir: 'asc' };

/**
 * Shared header cell. The label text is the cell's whole accessible name,
 * so tests and screen readers keep finding columns by the words on them.
 */
export function SortHeader(props: {
  label: string;
  field: string;
  sort: SortState;
  onSort: (field: string) => void;
  align?: 'left' | 'right' | 'center';
}): React.ReactElement {
  const { label, field, sort, onSort, align } = props;
  const active = sort.field === field;
  return (
    <TableCell sortDirection={active ? sort.dir : false} align={align}>
      <TableSortLabel
        active={active}
        direction={active ? sort.dir : 'asc'}
        onClick={() => onSort(field)}
      >
        {label}
      </TableSortLabel>
    </TableCell>
  );
}

/** One comparison for every column kind: nulls sink, numbers compare, the
 * rest compare as the words the office reads. */
export const compareCells = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' || typeof b === 'number') {
    return Number(a) - Number(b);
  }
  return String(a).localeCompare(String(b));
};

/**
 * Client-side sort for whole-result tables. Returns a new array — the row
 * state a page holds is the fetch's answer, and mutating it would make the
 * screen disagree with the server about what was retrieved.
 */
export function useClientSort<R>(
  rows: R[],
  accessors: Record<string, (r: R) => unknown>,
  initialField: string,
  initialDir: SortDir = 'asc',
): { sort: SortState; onSort: (field: string) => void; sorted: R[] } {
  const [sort, setSort] = React.useState<SortState>({ field: initialField, dir: initialDir });
  const acc = accessors[sort.field];
  const sorted = React.useMemo(() => {
    if (!acc) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((x, y) => compareCells(acc(x), acc(y)) * dir);
  }, [rows, acc, sort.dir]);
  const onSort = React.useCallback(
    (field: string) => setSort((s) => nextSort(s, field)), []);
  return { sort, onSort, sorted };
}
