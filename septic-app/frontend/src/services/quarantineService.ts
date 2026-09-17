import axios from 'axios';

const API_BASE = '/api';

/**
 * A client for the quarantine queue — the rows the migration refused to interpret.
 *
 * Three things are worth knowing before changing this file.
 *
 *  - `family` is not `reason`. The `orphan_line_*` codes carry the invoice number inside
 *    the string, so the 3,876 rows in the queue hold 2,944 distinct reasons and a filter
 *    built from them would be a 2,944-entry dropdown. `family` is `split_part(reason,
 *    ':', 1)` — the nine kinds of failure. Never send a raw reason as a filter.
 *  - `raw` is the source row exactly as the CSV had it, dollar signs and all. It is
 *    rendered as text on purpose. Parsing "$175.00" into a number here would throw away
 *    the one thing worth looking at, which is what the file actually contained.
 *  - Resolve and unresolve are the only writes in the app, and they are the only place a
 *    user can change a fact. The server enforces the role; `canResolve` below only stops
 *    the screen offering a button that is going to answer 403.
 */

export type QuarantineStatus = 'open' | 'resolved' | 'all';

export interface QuarantineFamily {
  family: string;
  total: string;
  open: string;
  resolved: string;
  source_files: string[];
}

export interface QuarantineRow {
  id: number;
  source_file: string;
  row_no: number;
  reason: string;
  /** The source row verbatim. Keys are the legacy column names, values are as written. */
  raw: Record<string, string | null>;
  quarantined_at: string | null;
  resolved_at: string | null;
  resolved_by: number | null;
  resolved_by_name: string | null;
}

export interface QuarantineMeta {
  total: number;
  limit: number;
  offset: number;
  status: QuarantineStatus;
  family: string | null;
  source_file: string | null;
}

interface Envelope<T> {
  success: boolean;
  data: T;
  meta?: QuarantineMeta;
  message?: string;
  /** An Internal error NNNNNNNN reference into the server log. Never a description. */
  error?: string;
}

/**
 * Unwraps the server envelope or throws a message worth showing.
 *
 * A non-2xx that still carries a message is thrown rather than returned: a 403 from the
 * role gate is a real answer the person at the keyboard needs to see, not something to
 * swallow and render as an empty queue. An empty queue and a refused request look the
 * same on screen and mean opposite things.
 */
async function call<T>(
  path: string, method: 'get' | 'post' = 'get',
): Promise<{ data: T; meta?: QuarantineMeta }> {
  const res = await axios[method]<Envelope<T>>(`${API_BASE}${path}`);
  const body = res.data;
  if (!body.success) {
    throw new Error(body.message || body.error || 'Request failed');
  }
  return { data: body.data, meta: body.meta };
}

/** Roles the server allows to close a row. Kept beside the gate it mirrors. */
export const CAN_RESOLVE_ROLES: readonly string[] = ['admin', 'manager', 'office'];

export const quarantineService = {
  families: () => call<QuarantineFamily[]>('/quarantine/families'),

  list: (params: {
    family?: string | null;
    source_file?: string | null;
    status?: QuarantineStatus;
    page?: number;
    limit?: number;
  }) => {
    const q = new URLSearchParams();
    if (params.family) q.set('family', params.family);
    if (params.source_file) q.set('source_file', params.source_file);
    if (params.status && params.status !== 'open') q.set('status', params.status);
    if (params.page) q.set('page', String(params.page));
    if (params.limit) q.set('limit', String(params.limit));
    return call<QuarantineRow[]>(`/quarantine?${q.toString()}`);
  },

  resolve: (id: number) => call<{ id: number; already_resolved: boolean }>(
    `/quarantine/${id}/resolve`, 'post',
  ),

  unresolve: (id: number) => call<{ id: number; already_open: boolean }>(
    `/quarantine/${id}/unresolve`, 'post',
  ),
};
