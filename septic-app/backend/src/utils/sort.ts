/**
 * Sorting is a whitelist, because an ORDER BY fragment is interpolated and
 * anything a caller may type that reaches SQL is a hole. Each endpoint hands
 * `parseSort` its own map of display names to column expressions; nothing
 * outside those maps can appear in a query.
 *
 * Refusals name the choices — a caller who guesses `?sort=name` on a queue
 * that sorts by `payer` should learn the difference from the answer.
 */
export interface Sort {
  column: string;
  dir: 'asc' | 'desc';
}

export type ParsedSort = { sort: Sort } | { error: string };

export const parseSort = (
  query: Record<string, unknown>,
  sorts: Record<string, string>,
  defaultKey: string,
  defaultDir: 'asc' | 'desc' = 'asc',
): ParsedSort => {
  const key = String(query.sort ?? defaultKey);
  if (!(key in sorts)) {
    return { error: `sort must be one of: ${Object.keys(sorts).join(', ')}` };
  }
  const dir = String(query.dir ?? defaultDir).toLowerCase();
  if (dir !== 'asc' && dir !== 'desc') {
    return { error: 'dir must be asc or desc' };
  }
  return { sort: { column: sorts[key], dir } };
};
