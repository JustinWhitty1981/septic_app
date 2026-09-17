import axios from 'axios';

const API_BASE = '/api';

/**
 * The regulatory ledger's read surface and its one sanctioned write.
 *
 * Three shapes of response live behind this one file, and each is handled the
 * way it actually arrives:
 *
 *  - `/ledger/report` is NOT enveloped — it returns the report object bare
 *    (`{report, months, by_site, totals}`), because it was built as a document
 *    first and an endpoint second. Wrapping it now would be churn the report
 *    itself does not care about.
 *  - `/ledger/events` follows the `{success, data}` envelope every other read
 *    uses.
 *  - `/ledger/:id/correct` answers with its own small contract, documented at
 *    `correctEvent`.
 *
 * The month rows carry `events_without_gallons` beside the gallon sum on
 * purpose: a report that only showed totals would silently mean "the rows
 * that remembered", which is the exact failure LED-04 refuses.
 */

export interface ReportMonth {
  month: string;
  events: number;
  events_without_gallons: number;
  gallons: string;
}

export interface ReportSiteRow {
  month: string;
  disposal_site_id: number | null;
  disposal_site: string;
  events: number;
  events_without_gallons: number;
  gallons: string;
}

export interface LedgerReport {
  report: string;
  generated: string;
  from: string;
  to: string;
  months: ReportMonth[];
  by_site: ReportSiteRow[];
  totals: { events: number; events_without_gallons: number; gallons: string };
}

export interface LedgerEvent {
  id: string;
  service_date: string;
  status: string;
  gallons_pumped: string | null;
  source: string;
  waste_note: string | null;
  dnr_permit_number: string | null;
  cert_as_recorded: string | null;
  corrects_event_id: string | null;
  waste_type: string | null;
  disposal_site: string | null;
  pumper_first: string | null;
  pumper_last: string | null;
  superseded: boolean;
}

/** The server's own words, surfaced from an axios failure. The 4xx bodies carry
 * a message the person at the keyboard can act on; the 5xx carry only an
 * `Internal error NNNNNNNN` reference, which is what they should show. */
export function messageOf(err: unknown): string {
  const e = err as { response?: { data?: { error?: string; message?: string } } };
  return e?.response?.data?.error || e?.response?.data?.message
    || (err instanceof Error ? err.message : 'Request failed');
}

export interface CorrectionResult {
  event: { id: string; corrects_event_id: string };
  supersedes: string;
  corrected_fields: string[];
}

async function envelope<T>(path: string): Promise<T> {
  const res = await axios.get<{ success: boolean; data: T }>(`${API_BASE}${path}`);
  if (!res.data.success) throw new Error('Request failed');
  return res.data.data;
}

/**
 * BIL-19's row: a pump-out the office still has to bill. `service_event_id` is
 * a bigint (the driver returns it as a string); the money here is gallons, and
 * the invoice that retires the row is written against that id, not the site.
 */
export interface UnbilledRow {
  service_event_id: string;
  property_id: number;
  legacy_cust_number: number | null;
  payer_label: string | null;
  site_address: string | null;
  site_city: string | null;
  county_id: number | null;
  service_date: string;
  days_ago: number;
  gallons_pumped: string | null;
  source: string;
  waste_type: string | null;
  disposal_site: string | null;
  /** The site's current owner (BIL-20): who the invoice would be addressed
   * to if the office created it from this row, without a second search. */
  owner_payer_id: number | null;
  owner_payer_name: string | null;
}

export interface UnbilledMeta {
  total: number;
  limit: number;
  offset: number;
  days: number | 'all';
  sort: string;
  dir: 'asc' | 'desc';
  business_today: string;
}

async function pagedEnvelope<T>(
  path: string, params: Record<string, unknown>,
): Promise<{ data: T[]; meta: UnbilledMeta }> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const res = await axios.get<{ success: boolean; data: T[]; meta: UnbilledMeta }>(
    `${API_BASE}${path}${q.toString() ? `?${q}` : ''}`,
  );
  if (!res.data.success) throw new Error('Request failed');
  return { data: res.data.data, meta: res.data.meta };
}

/** Render 'YYYY-MM-DD' from either a bare date or a server UTC instant. */
export const day = (iso: string | null): string =>
  iso ? String(iso).slice(0, 10) : '';

export interface WasteTypeOption { id: number; name: string; is_dnr_permitted: boolean }
export interface DisposalSiteOption {
  id: number; name: string; dnr_permit_no: string | null; accepts_slurry: boolean;
}

export const ledgerService = {
  lookups: () => envelope<{
    waste_types: WasteTypeOption[];
    disposal_sites: DisposalSiteOption[];
  }>('/ledger/lookups'),
  report: async (from?: string, to?: string): Promise<LedgerReport> => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const res = await axios.get<LedgerReport>(`${API_BASE}/ledger/report${q.toString() ? `?${q}` : ''}`);
    return res.data;
  },

  events: (propertyId: number) =>
    envelope<LedgerEvent[]>(`/ledger/events?property_id=${propertyId}`),

  /**
   * The one write. `changes` is restricted server-side to what was measured at
   * the site — property, date and pumper are identity, and the 400 says so in
   * full; the dialog should surface that message verbatim rather than
   * pre-guessing the list.
   */
  /**
   * DRV-20: file a pump-out that was never on a route. `client_uuid` is minted
   * once when the dialog opens and reused across retries, so the phone with
   * the bad signal files the job once (DRV-13's contract at this door).
   * Answers with the event and any warnings the server attached — an
   * anonymous row or a no-gallons row is filed *and* said out loud.
   */
  record: async (input: {
    property_id: number; disposal_site_id: number; gallons_pumped?: number | null;
    waste_type_id?: number | null; waste_note?: string | null; client_uuid?: string;
  }): Promise<{ event: Record<string, unknown>; warnings?: string[] }> => {
    const res = await axios.post<{ success: boolean; data: Record<string, unknown>;
      warnings?: string[] }>(`${API_BASE}/ledger/events`, input);
    if (!res.data.success) throw new Error('Request failed');
    return { event: res.data.data, warnings: res.data.warnings };
  },

  correct: async (eventId: string, changes: Record<string, unknown>, note: string)
    : Promise<CorrectionResult> => {
    const res = await axios.post<CorrectionResult>(
      `${API_BASE}/ledger/${eventId}/correct`, { ...changes, note },
    );
    return res.data;
  },

  /**
   * BIL-19: the billing queue — completed, current pump-outs that carry no
   * invoice line yet. Read from heads only, so a correction swaps the entry
   * instead of duplicating it: one truck afternoon is one billable thing.
   */
  unbilled: (params: {
    days?: number | 'all'; page?: number; limit?: number;
    sort?: string; dir?: 'asc' | 'desc'; property_id?: number;
  } = {}): Promise<{ data: UnbilledRow[]; meta: UnbilledMeta }> =>
    pagedEnvelope<UnbilledRow>('/ledger/unbilled-events', params),
};
