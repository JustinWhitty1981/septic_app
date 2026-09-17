import axios from 'axios';

const API_BASE = '/api';

/**
 * A client for scheduling and dispatch.
 *
 * Two audiences on one set of types, which is why some of them are nearly empty:
 *
 *  - the **office** composes a day through `/routes` — create it, add sites, order them,
 *    publish it. Everything here that mutates is office-only; the server says so with a 403
 *    and `CAN_ROUTE_ROLES` only stops the screen offering a button that will be refused.
 *  - the **driver** reads one thing: `GET /dispatch/today`, which returns the whole day in
 *    one response and is the only request the PWA makes at launch.
 *
 * Three details are load-bearing.
 *
 *  - **Dates are `string`, never `Date`.** The server renders them with
 *    `to_char(..., 'YYYY-MM-DD')` so a site due on the 1st does not slide into the previous
 *    month when JSON turns a `date` column into a UTC instant. Parsing these back with
 *    `new Date()` re-introduces exactly that bug. Timestamps — `arrived_at` — are genuine
 *    instants and do arrive as ISO strings; only the bare dates lie.
 *
 *  - **"Today" is the server's, not the browser's.** `business_today` on both responses is
 *    what the app was built against. The dev database is frozen at 2024-12-02 and a phone's
 *    clock is not, so a screen that computed today locally would show a driver an empty list
 *    and look like the office had forgotten them (P10).
 *
 *  - **`version` is sent back on a reorder and is not a formality.** It is the version the
 *    screen read. Two tablets open on one day is the normal condition; the server refuses the
 *    second save rather than merging the two orders, because a merge would decide silently
 *    whose order the driver drives. Treat a 409 as "reload and look", never as a retry.
 */

export type RouteStatus = 'draft' | 'published' | 'in_progress' | 'done';
export type StopStatus = 'pending' | 'arrived' | 'done' | 'no_access' | 'skipped';

/** A place waste may lawfully end up. The `done` write must name one. */
export interface DisposalSite {
  id: number;
  name: string;
  accepts_slurry: boolean | null;
  permitted: boolean;
  /** The company default (DRV-20): what the Done dialog pre-selects. */
  is_default: boolean;
}

export interface RouteSummary {
  id: number;
  route_date: string;
  status: RouteStatus;
  version: number;
  truck_label: string | null;
  driver_id: number;
  first_name: string;
  last_name: string;
  stop_count: number;
  pending_count: number;
  business_today: string;
}

export interface RouteStopRow {
  id: number;
  sequence_no: number;
  status: StopStatus;
  version: number;
  property_id: number;
  legacy_cust_number: number | null;
  payer_label: string | null;
  site_address: string | null;
  site_city: string | null;
  county_name: string | null;
  county_raw: string | null;
  next_service_due: string | null;
  tank_count: number;
}

export interface RouteDetail extends Omit<RouteSummary, 'stop_count' | 'pending_count'> {
  created_at: string;
  stops: RouteStopRow[];
}

/** One tank as the driver sees it: the parsed numbers, and the string they came from. */
export interface TankOnCard {
  sequence_no: number;
  role: 'primary' | 'pre_cleanout' | 'sand_filter' | 'secondary';
  gallons: number | null;
  has_filter: boolean;
  /** Verbatim from `tanks.raw_text` — '800PC', '1500w.fltr', '2000 triple'. */
  raw: string;
}

export interface DispatchStop {
  stop_id: number;
  sequence_no: number;
  stop_status: StopStatus;
  stop_version: number;
  arrived_at: string | null;
  completed_at: string | null;
  property_id: number;
  legacy_cust_number: number | null;
  payer_label: string | null;
  site_address: string | null;
  site_city: string | null;
  site_state: string | null;
  site_zip: string | null;
  /** Normalised. NULL for the 49 sites 0013 refused to guess a county for. */
  county_name: string | null;
  /** Exactly as recorded. Either one alone is a guess. */
  county_raw: string | null;
  tank_location_note: string | null;
  jobsite_location_note: string | null;
  chamber_pump_note: string | null;
  system_condition_note: string | null;
  reminder_opt_out: boolean;
  next_service_due: string | null;
  tanks: TankOnCard[];
}

export interface DispatchDay {
  route_id: number;
  route_date: string;
  route_status: RouteStatus;
  route_version: number;
  truck_label: string | null;
  business_today: string;
  driver: { id: number; first_name: string; last_name: string };
  stop_count: number;
  stops: DispatchStop[];
}

/**
 * `business_today` is on the envelope rather than only inside the rows so that an empty day
 * still answers it — which is the state where a screen needs it most, because an empty day is
 * the one it is about to fill in.
 */
export interface Meta {
  date: string | null;
  business_today?: string;
}

interface Envelope<T> {
  success: boolean;
  data: T;
  meta?: Meta;
  message?: string;
  /** Present on the 409s, which name the thing already in the way. */
  route_id?: number;
  already_on_route_id?: number;
  current_version?: number;
  you_sent?: number;
  missing?: number[];
  unknown?: number[];
  /** An Internal error NNNNNNNN reference into the server log. Never a description. */
  error?: string;
}

/**
 * A refusal is thrown, not returned as an empty list.
 *
 * The dispatch screen cannot tell "you have nothing today" from "the request failed" if a
 * 404 resolves to `[]`, and those two sentences send a driver in opposite directions — one
 * means wait or phone the office, the other means the app is broken. So the caller gets the
 * status code and the server's own words, and the screen can print the difference.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Envelope<unknown>;

  constructor(body: Envelope<unknown>, status: number) {
    super(body.message || body.error || 'Request failed');
    this.status = status;
    this.body = body;
  }
}

async function call<T>(
  path: string,
  method: 'get' | 'post' | 'patch' | 'delete' = 'get',
  body?: unknown,
): Promise<{ data: T; meta?: Meta }> {
  try {
    const res = await axios[method]<Envelope<T>>(`${API_BASE}${path}`, body);
    if (!res.data.success) throw new ApiError(res.data, res.status);
    return { data: res.data.data, meta: res.data.meta };
  } catch (err) {
    // A 4xx arrives here rather than as a resolved response, and the useful half of it —
    // "Already routed on 2024-12-02 to Dana (route 7). Remove it there first." — is in the
    // body. Losing it to `err.message` would leave the raw axios string.
    if (axios.isAxiosError(err) && err.response?.data) {
      throw new ApiError(err.response.data as Envelope<unknown>, err.response.status);
    }
    throw err;
  }
}

/** Roles the server allows to compose a day. Kept beside the gate it mirrors. */
export const CAN_ROUTE_ROLES: readonly string[] = ['admin', 'manager', 'office'];

export interface DriverOption {
  id: number;
  first_name: string;
  last_name: string;
  role: 'driver';
}

export const routeService = {
  /**
   * Where the waste went — the list the `done` write is judged against.
   *
   * The server refuses `done` without `disposal_site_id`, so the driver's
   * screen cannot finish a job without these ids, and inventing or
   * hard-coding one would file a compliance record pointing at a site the
   * truck never visited.
   */
  disposalSites: async (): Promise<DisposalSite[]> => {
    const { data } = await call<DisposalSite[]>('/disposal-sites');
    return data;
  },

  /** Move the company default. Office role; the server validates the id. */
  setDisposalDefault: async (siteId: number): Promise<void> => {
    await call('/disposal-sites/default', 'patch', { site_id: siteId });
  },

  forDate: (date?: string) =>
    call<RouteSummary[]>(`/routes${date ? `?date=${encodeURIComponent(date)}` : ''}`),

  /** The people who can be given a day. Creating a route means naming one of them. */
  drivers: () => call<DriverOption[]>('/routes/drivers'),

  detail: (id: number) => call<RouteDetail>(`/routes/${id}`),

  create: (input: { route_date: string; driver_id: number; truck_label?: string | null }) =>
    call<{ id: number; route_date: string; status: RouteStatus; version: number }>(
      '/routes', 'post', input,
    ),

  addStop: (routeId: number, propertyId: number) =>
    call<{ id: number; sequence_no: number; status: StopStatus }>(
      `/routes/${routeId}/stops`, 'post', { property_id: propertyId },
    ),

  /**
   * SCH-13: put a site on a driver's day without knowing (or having) the route id.
   *
   * One POST, one transaction server-side: if the day does not exist it is created, and
   * if the site turns out to be already routed that day the created day is rolled back
   * with the refusal — so a clash leaves nothing for a driver who never asked for it.
   * `route_created` says whether this request opened the day; the confirmation line
   * should repeat it.
   */
  addStopForDay: (input: { property_id: number; driver_id: number; route_date: string }) =>
    call<{ id: number; sequence_no: number; status: StopStatus; route_id: number;
           route_date: string; driver_id: number; route_created: boolean }>(
      '/routes/stops', 'post', input,
    ),

  removeStop: (routeId: number, stopId: number) =>
    call<{ id: number; removed: boolean }>(`/routes/${routeId}/stops/${stopId}`, 'delete'),

  /** `version` must be the one the screen read. See the note at the top of this file. */
  reorder: (routeId: number, stopIds: number[], version: number) =>
    call<{ route_id: number; version: number }>(
      `/routes/${routeId}/stops`, 'patch', { stop_ids: stopIds, version },
    ),

  publish: (routeId: number) =>
    call<{ route_id: number; status: RouteStatus; version: number; stop_count: number }>(
      `/routes/${routeId}/publish`, 'post', {},
    ),

  unpublish: (routeId: number) =>
    call<{ route_id: number; status: RouteStatus; version: number }>(
      `/routes/${routeId}/unpublish`, 'post', {},
    ),

  /** The driver's launch request. One call, the whole day. */
  today: () => call<DispatchDay>('/dispatch/today'),
};

