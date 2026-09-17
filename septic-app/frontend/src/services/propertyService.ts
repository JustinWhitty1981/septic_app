import axios from 'axios';

const API_BASE = '/api';

/**
 * A client for the four property endpoints.
 *
 * The types here describe what the server actually sends, which is narrower and more
 * literal than the types in the services they replace. Those modelled a domain the
 * schema does not have — customers, inventory items, compliance records — and every
 * one of them was correct right up until the request went out and came back 404.
 *
 * Two details are load-bearing and easy to "fix" into a bug:
 *
 *  - Dates are `string`, not `Date`. The server renders every date with
 *    to_char(..., 'YYYY-MM-DD') precisely so that a service due on the 1st does not
 *    become due on the previous month's last day when JSON turns a date column into a
 *    UTC instant. Parsing these back with new Date() re-introduces exactly that bug,
 *    because 'YYYY-MM-DD' is read as midnight UTC and then displayed in local time.
 *    Render them as text, or parse them by splitting on '-'.
 *  - `days_overdue` is negative for a site that is not due yet. The queue holds both
 *    halves and the sign is the only thing separating "get someone out there" from
 *    "book it for next month".
 */

export type DueFilter = 'overdue' | 'week' | 'due_30' | 'all';

export interface DueQueueRow {
  property_id: number;
  legacy_cust_number: number | null;
  payer_label: string | null;
  site_address: string | null;
  site_city: string | null;
  county_id: number | null;
  status: 'active' | 'inactive' | 'sealed' | 'unknown';
  next_service_due: string | null;
  days_overdue: number;
  // SCH-16: what the office is acting on. The generated column keeps
  // travelling beside it untouched — the page shows the effective date and
  // the sentence that justifies it, never a field anybody can type over.
  effective_due_date: string | null;
  adjusted: boolean;
  adjustment_reason: string | null;
  // SCH-15: a booking, when the toggle asks for them. Drafts say draft.
  scheduled_on: string | null;
  scheduled_status: 'draft' | 'published' | 'in_progress' | 'done' | null;
  scheduled_driver: string | null;
}

export interface PropertySummary {
  id: number;
  legacy_cust_number: number | null;
  payer_label: string | null;
  site_address: string | null;
  site_city: string | null;
  site_state: string | null;
  site_zip: string | null;
  county_id: number | null;
  status: 'active' | 'inactive' | 'sealed' | 'unknown';
  permit_number: string | null;
  service_interval_days: number;
  last_service_date: string | null;
  next_service_due: string | null;
}

export interface Tank {
  id: number;
  sequence_no: number;
  role: 'primary' | 'pre_cleanout' | 'sand_filter' | 'secondary';
  capacity_gallons: number | null;
  has_filter: boolean;
  /** The string the source actually contained. Kept so a wrong parse stays checkable. */
  raw_text: string;
}

export interface PropertyOwner {
  id: number;
  payer_id: number;
  is_primary: boolean;
  source: string;
  payer_name: string | null;
  phone: string | null;
  email: string | null;
  ownership_start: string | null;
}

export interface RecentEvent {
  id: number;
  service_date: string;
  status: string;
  gallons_pumped: string | null;
  source: string;
  cert_unresolved: boolean;
  pumper: string | null;
  disposal_site: string | null;
}

export interface PropertyDetail extends Omit<PropertySummary, 'id'> {
  id: number;
  town: string | null;
  county_raw: string | null;
  county_name: string | null;
  system_type_name: string | null;
  tank_location_note: string | null;
  jobsite_location_note: string | null;
  pump_style_note: string | null;
  chamber_pump_note: string | null;
  system_condition_note: string | null;
  reminder_opt_out: boolean;
  legacy_memo: string | null;
  tanks: Tank[];
  owners: PropertyOwner[];
  recent_events: RecentEvent[];
}

export interface PageMeta {
  total: number;
  limit: number;
  offset: number;
  filter?: DueFilter;
  county_id?: number | null;
  overdue_total?: number;
  show_scheduled?: boolean;
  business_today?: string;
}

interface Envelope<T> {
  success: boolean;
  data: T;
  meta?: PageMeta;
  message?: string;
  /** An Internal error NNNNNNNN reference into the server log. Never a description. */
  error?: string;
}

/**
 * Unwraps the server envelope or throws a message worth showing.
 *
 * The server deliberately never repeats a database error (NF-11), so `error` is a
 * reference like "Internal error 4F2A91C0" rather than a reason. It is still worth
 * putting in front of a person: quoting that reference is how the office reports
 * something and the log line turns up.
 */
async function call<T>(path: string): Promise<{ data: T; meta?: PageMeta }> {
  const res = await axios.get<Envelope<T>>(`${API_BASE}${path}`);
  const body = res.data;
  if (!body.success) {
    throw new Error(body.message || body.error || 'Request failed');
  }
  return { data: body.data, meta: body.meta };
}

/**
 * What the create/patch endpoints return: the property row with its joined
 * names — but NOT the detail page's `tanks` / `owners` / `recent_events`,
 * which `GET /properties/:id` assembles separately. Saying `PropertyDetail`
 * here was a type-level lie with a runtime exception attached: a caller that
 * trusted it and `setRow(response)` crashed the next render on
 * `row.tanks.length`. The write endpoints answer about the row; the screen
 * re-reads the detail.
 */
export type PropertyRecord = Omit<PropertyDetail, 'tanks' | 'owners' | 'recent_events'>;

/**
 * The fields the office may write (SCH-11). Mirrors the server's whitelist
 * one-for-one — deliberately not wider, because the server's 400 messages are
 * the documentation of what each field accepts, and a client that pre-allows
 * more would only paraphrase them worse.
 *
 * Absent is load-bearing: `next_service_due`, `last_service_date`,
 * `legacy_memo`, `county_raw`. The ledger and the migration own those, and a
 * UI field for either date is exactly the 32,396 hand-typed due dates of P1
 * waiting to happen again.
 */
export interface PropertyInput {
  legacy_cust_number?: number | null;
  payer_label?: string | null;
  site_address?: string | null;
  site_city?: string | null;
  site_state?: string | null;
  site_zip?: string | null;
  county_id?: number | null;
  town?: string | null;
  plss_section?: string | null;
  plss_range?: string | null;
  parcel_id?: string | null;
  permit_number?: string | null;
  system_type_id?: number | null;
  tank_location_note?: string | null;
  jobsite_location_note?: string | null;
  pump_style_note?: string | null;
  chamber_pump_note?: string | null;
  system_condition_note?: string | null;
  baffle_inlet_date?: string | null;
  baffle_outlet_date?: string | null;
  pump_installed_date?: string | null;
  hose_count?: number | null;
  service_interval_days?: number;
  reminder_opt_out?: boolean;
  status?: 'active' | 'inactive' | 'sealed' | 'unknown';
}

async function send<T>(method: 'post' | 'patch', path: string, body: object): Promise<T> {
  const res = await axios[method]<Envelope<T>>(`${API_BASE}${path}`, body);
  if (!res.data.success) {
    throw new Error(res.data.message || res.data.error || 'Request failed');
  }
  return res.data.data;
}

export const propertyService = {
  dueQueue: (params: {
    filter: DueFilter; county_id?: number | null; page?: number; limit?: number;
    show_scheduled?: boolean; sort?: string; dir?: 'asc' | 'desc';
  }) => {
    const q = new URLSearchParams();
    q.set('filter', params.filter);
    if (params.county_id) q.set('county_id', String(params.county_id));
    if (params.page) q.set('page', String(params.page));
    if (params.limit) q.set('limit', String(params.limit));
    if (params.show_scheduled) q.set('show_scheduled', '1');
    if (params.sort) q.set('sort', params.sort);
    if (params.dir) q.set('dir', params.dir);
    return call<DueQueueRow[]>(`/properties/due-queue?${q.toString()}`);
  },

  /**
   * SCH-16. The overlay row, not an edit: `send` returns the server's row on
   * success and throws its sentence on refusal — past dates, blank reasons and
   * second open adjustments all come back named, and the page shows the
   * server's words rather than paraphrasing them.
   */
  adjustDue: (propertyId: number, input: { adjusted_due_date: string; reason: string }) =>
    send<{ id: number; adjusted_due_date: string; reason: string }>(
      'post', `/properties/${propertyId}/due-adjustments`, input,
    ),

  closeDueAdjustment: async (propertyId: number): Promise<{ id: number; closed: boolean }> => {
    const res = await axios.delete<Envelope<{ id: number; closed: boolean }>>(
      `${API_BASE}/properties/${propertyId}/due-adjustments`,
    );
    if (!res.data.success) {
      throw new Error(res.data.message || res.data.error || 'Request failed');
    }
    return res.data.data;
  },

  list: (params: { status?: string; county_id?: number | null; page?: number; limit?: number }) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.county_id) q.set('county_id', String(params.county_id));
    if (params.page) q.set('page', String(params.page));
    if (params.limit) q.set('limit', String(params.limit));
    return call<PropertySummary[]>(`/properties?${q.toString()}`);
  },

  search: (q: string) => call<PropertySummary[]>(`/properties/search?q=${encodeURIComponent(q)}`),

  detail: (id: number) => call<PropertyDetail>(`/properties/${id}`),

  /** Add a site (SCH-11). The server answers with the new row — not the detail; refetch if you need the page's shape. */
  create: (input: PropertyInput & { site_address: string }) =>
    send<PropertyRecord>('post', '/properties', input),

  /**
   * A narrow edit (SCH-11): only the named fields move. The response is the
   * row, not the detail — callers re-read the detail before rendering it.
   */
  update: (id: number, patch: PropertyInput) =>
    send<PropertyRecord>('patch', `/properties/${id}`, patch),
};
