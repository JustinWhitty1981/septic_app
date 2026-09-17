import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';
import { parseSort } from '../utils/sort';
import { PROPERTY_STATUS, PropertyStatus } from '../models/enums';

/**
 * The property directory and the due queue.
 *
 * Two things are worth knowing before editing this file.
 *
 * First, every date here is rendered with `to_char(..., 'YYYY-MM-DD')` rather than
 * handed to `res.json` as a Date. node-postgres returns a `date` column as a
 * JavaScript Date at local midnight, and JSON then serialises it as a UTC instant — so
 * a service due on the 1st reads as due on the last day of the previous month to
 * anyone east of Greenwich and to nobody west of it. That is a bug that appears on
 * Mondays and never in the developer's timezone. A date column leaves this file as the
 * eight characters the database meant.
 *
 * Second, there are no `relations` to load. The entities deliberately carry plain
 * foreign-key columns instead of relation decorators, so the joins you need are the
 * ones written below, visible in the file that runs them.
 *
 * Errors go through `internalError` and never carry their own message (NF-11). These
 * routes sit behind `authenticate` with no role check, so a driver's tablet holds the
 * same access here as the office manager does; narrowing that is open work, not a
 * decision this file gets to make quietly.
 */

/** Whitelisted, because the fragment is interpolated into SQL and nothing else may reach it. */
const DUE_FILTERS: Record<string, string> = {
  overdue: 'q.days_overdue > 0',
  week: 'q.days_overdue BETWEEN -7 AND 0',
  due_30: 'q.days_overdue BETWEEN -30 AND 0',
};

/** Page size, clamped. 500 is above anything a browser needs and below a memory problem. */
function paging(req: Request, max = 500): { limit: number; offset: number } {
  const raw = Number(req.query.limit);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), max) : 100;
  const page = Number(req.query.page);
  const p = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  return { limit, offset: (p - 1) * limit };
}

/**
 * NULL unless the query string holds a positive 32-bit integer, so '' and 'abc' cannot
 * reach a $param — and neither can a number too large to be one.
 *
 * The ceiling matters as much as the floor. '9999999999' is a perfectly well-formed
 * number, and without the bound it reaches Postgres as an integer literal that does
 * not fit, which comes back as a database error and leaves the server reporting a
 * client's typo as its own failure. A URL that cannot name a row should be answered
 * from the URL.
 */
const INT4_MAX = 2_147_483_647;
function intParam(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= INT4_MAX ? n : null;
}

/* ------------------------------------------------------------------------- *
 * The editable surface (SCH-11).
 *
 * The office can add a site and fix its facts. What the *ledger* owns stays
 * behind the counter, and the reason has a number: P1. The legacy app let
 * anybody type into Next Service Date, and it disagreed with
 * service_date + interval in 32,396 of 45,804 rows. A generated column and a
 * ledger-maintained date are the fix, and an edit endpoint that quietly
 * accepted `next_service_due` would undo the fix with a 200. So the columns
 * that are not ours to write are refused by name and reason — an ignored
 * field is a field somebody will believe they set.
 * ------------------------------------------------------------------------- */

type FieldKind = 'text' | 'state' | 'posint' | 'bool' | 'decimal' | 'date' | 'status' | 'fk';

interface FieldSpec {
  kind: FieldKind; max?: number; table?: string; label?: string;
}

const EDITABLE: Record<string, FieldSpec> = {
  legacy_cust_number: { kind: 'posint' },
  payer_label:              { kind: 'text', max: 200 },
  site_address:             { kind: 'text', max: 255 },
  site_city:                { kind: 'text', max: 100 },
  site_state:               { kind: 'state' },
  site_zip:                 { kind: 'text', max: 10 },
  county_id:                { kind: 'fk', table: 'counties', label: 'county' },
  town:                     { kind: 'text', max: 100 },
  plss_section:             { kind: 'text', max: 10 },
  plss_range:               { kind: 'text', max: 10 },
  parcel_id:                { kind: 'text', max: 40 },
  permit_number:            { kind: 'text', max: 30 },
  system_type_id:           { kind: 'fk', table: 'septic_system_types', label: 'system type' },
  tank_location_note:       { kind: 'text' },
  jobsite_location_note:    { kind: 'text' },
  pump_style_note:          { kind: 'text' },
  chamber_pump_note:        { kind: 'text' },
  system_condition_note:    { kind: 'text' },
  baffle_inlet_material_id:  { kind: 'fk', table: 'baffle_materials', label: 'baffle material' },
  baffle_outlet_material_id: { kind: 'fk', table: 'baffle_materials', label: 'baffle material' },
  baffle_inlet_date:        { kind: 'date' },
  baffle_outlet_date:       { kind: 'date' },
  pump_installed_date:      { kind: 'date' },
  hose_count:               { kind: 'decimal' },
  service_interval_days:    { kind: 'posint' },
  reminder_opt_out:         { kind: 'bool' },
  status:                   { kind: 'status' },
};

/** Not unknown fields — known fields that belong to somebody else. */
const NEVER: Record<string, string> = {
  id: 'id is assigned by the database.',
  next_service_due: 'next_service_due is derived from the ledger and cannot be written (SCH-02).',
  last_service_date: 'last_service_date is maintained by the ledger, not by an editor (SCH-01).',
  legacy_memo: 'legacy_memo is immutable legacy evidence (P3).',
  county_raw: 'county_raw is the evidence county_id was derived from; it is never rewritten (P3).',
  created_at: 'created_at is written by the database.',
  updated_at: 'updated_at is written by the database.',
};

function checkValue(key: string, spec: FieldSpec, value: unknown): { value?: unknown; error?: string } {
  switch (spec.kind) {
    case 'text': {
      if (value === null) return { value: null };
      if (typeof value !== 'string') return { error: `${key} must be text or null` };
      const s = value.trim();
      if (spec.max && s.length > spec.max) return { error: `${key} is at most ${spec.max} characters` };
      return { value: s === '' ? null : s };
    }
    case 'state': {
      if (value === null) return { value: null };
      if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value.trim())) {
        return { error: 'site_state must be a two-letter state, e.g. WI' };
      }
      return { value: value.trim().toUpperCase() };
    }
    case 'posint': {
      if (value === null) return { value: null };
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0 || n > INT4_MAX) {
        return { error: `${key} must be a positive whole number or null` };
      }
      return { value: n };
    }
    case 'bool': {
      if (typeof value !== 'boolean') return { error: `${key} must be true or false` };
      return { value };
    }
    case 'decimal': {
      if (value === null) return { value: null };
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0 || n > 99.99) {
        return { error: 'hose_count must be a number greater than 0 and at most 99.99' };
      }
      return { value: String(n) };
    }
    case 'date': {
      if (value === null) return { value: null };
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { error: `${key} must be a date as YYYY-MM-DD` };
      }
      const [y, m, d] = value.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
        return { error: `${key} is not a real date` };
      }
      return { value };
    }
    case 'status': {
      if (!(PROPERTY_STATUS as readonly string[]).includes(value as string)) {
        return { error: `status must be one of: ${PROPERTY_STATUS.join(', ')}` };
      }
      return { value };
    }
    case 'fk': {
      if (value === null) return { value: null };
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0 || n > INT4_MAX) {
        return { error: `${key} must be a positive whole number or null` };
      }
      return { value: n };
    }
  }
}

/** Table names here come only from the EDITABLE whitelist, never from a body. */
async function existsIn(table: string, id: number): Promise<boolean> {
  const rows = await AppDataSource.query(`SELECT 1 FROM septic_app.${table} WHERE id = $1`, [id]);
  return rows.length > 0;
}

/**
 * Shared parse for create and patch: validate every named field, refuse a
 * field that is not ours to write (by name and reason, NF-11), and check the
 * foreign keys exist rather than letting Postgres answer a 400-shaped mistake
 * with a 500. `fk` labels name the vocabulary row the caller got wrong:
 * "No county has id 407.", the phrasing the disposal-site refusal already set.
 */
async function validateFields(
  body: unknown,
): Promise<{ error?: [number, object]; values?: Record<string, unknown> }> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: [400, { success: false, message: 'body must be a JSON object' }] };
  }
  const keys = Object.keys(body);
  const neverHit = keys.find((k) => k in NEVER);
  if (neverHit !== undefined) return { error: [400, { success: false, message: NEVER[neverHit] }] };
  const unknown = keys.find((k) => !(k in EDITABLE));
  if (unknown !== undefined) return { error: [400, { success: false, message: `Unknown field "${unknown}"` }] };

  const values: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(EDITABLE)) {
    if (!(key in body)) continue;
    const r = checkValue(key, spec, body[key]);
    if (r.error) return { error: [400, { success: false, message: r.error }] };
    values[key] = r.value;
    if (spec.kind === 'fk' && r.value !== null) {
      if (!(await existsIn(spec.table!, r.value as number))) {
        return { error: [400, { success: false, message: `No ${spec.label} has id ${r.value}.` }] };
      }
    }
  }
  return { values };
}

/** The one property read whose shape never changes (the AppDataSource rule). */
async function loadProperty(id: number): Promise<any> {
  const [prop] = await AppDataSource.query(
    `SELECT p.*, c.name AS county_name, st.name AS system_type_name,
            to_char(p.last_service_date, 'YYYY-MM-DD') AS last_service_date,
            to_char(p.next_service_due, 'YYYY-MM-DD')  AS next_service_due,
            to_char(p.baffle_inlet_date, 'YYYY-MM-DD') AS baffle_inlet_date,
            to_char(p.baffle_outlet_date, 'YYYY-MM-DD') AS baffle_outlet_date,
            to_char(p.pump_installed_date, 'YYYY-MM-DD') AS pump_installed_date
       FROM properties p
  LEFT JOIN counties c ON c.id = p.county_id
  LEFT JOIN septic_system_types st ON st.id = p.system_type_id
      WHERE p.id = $1`,
    [id],
  );
  return prop;
}

export const propertiesController = {
  /**
   * GET /api/properties/search?q=
   *
   * Searches the address, the payer label and the legacy customer number, because
   * those are the three things a human types when looking for a site: what is written
   * on the tank lid, whose name is on the bill, and what the crew said on the radio.
   * Searching only the address would make a third of these unfindable.
   */
  search: async (req: Request, res: Response) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const cust = /^\d+$/.test(q) ? intParam(q) : null;

      // A one- or two-digit query is a customer number or it is nothing. "2" is what a
      // crew says about cust #2, and matching it against 7,541 addresses as '%2%' would
      // return fifty houses with a 2 in the number and not the one site they meant. A
      // three-digit query could be a street number, so from there up both are searched.
      const exactOnly = cust !== null && q.length <= 2;

      if (q.length < 2 && !exactOnly) {
        return res.status(400).json({
          success: false,
          message: 'Search must be at least 2 characters, or a legacy customer number',
        });
      }

      const { limit, offset } = paging(req, 50);

      // Placeholders are numbered as the clauses are built, not fixed. With a fixed
      // $1 for the text search, the exact-number branch would send a parameter that
      // appears nowhere in the SQL, and Postgres answers that with
      // "could not determine data type of parameter $1" — a 500 for a valid request.
      const params: any[] = [];
      const clauses: string[] = [];
      let custIdx = 0;

      if (cust !== null) {
        params.push(cust);
        custIdx = params.length;
        clauses.push(`p.legacy_cust_number = $${custIdx}`);
      }
      if (!exactOnly) {
        params.push(`%${q.toLowerCase()}%`);
        const p = `$${params.length}`;
        clauses.push(
          `LOWER(coalesce(p.site_address,'')) LIKE ${p}`,
          `LOWER(coalesce(p.site_city,''))    LIKE ${p}`,
          `LOWER(coalesce(p.payer_label,''))  LIKE ${p}`,
        );
      }
      params.push(limit, offset);
      const limitPh = `$${params.length - 1}`;
      const offsetPh = `$${params.length}`;

      // An exact customer number sorts above anything the text search also matched, so
      // typing "2248" returns cust #2248 rather than 2248 Somewhere Road.
      const exactFirst = custIdx
        ? `($${custIdx}::int IS NOT NULL AND p.legacy_cust_number = $${custIdx}) DESC NULLS LAST, `
        : '';

      const rows = await AppDataSource.query(
        `SELECT p.id, p.legacy_cust_number, p.payer_label, p.site_address, p.site_city,
                p.site_state, p.site_zip, p.county_id, p.status,
                to_char(p.next_service_due, 'YYYY-MM-DD') AS next_service_due
           FROM properties p
          WHERE (${clauses.join(' OR ')})
          ORDER BY ${exactFirst}p.site_address NULLS LAST
          LIMIT ${limitPh} OFFSET ${offsetPh}`,
        params,
      );
      return res.json({ success: true, data: rows });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, message: 'Search failed', error: internalError(error) });
    }
  },

  /**
   * GET /api/properties/due-queue?filter=overdue|week|due_30|all&county_id=&page=&limit=
   *
   * Reads v_due_queue, which is not a table and is never refreshed: it is
   * `last_service_date + service_interval_days` evaluated at query time, against
   * `business_today()` rather than the session's own date, so the queue does not move
   * during a day's work. Nothing here recomputes it and nothing here is allowed to.
   *
   * The view is joined back to `properties` for one reason only: it does not expose
   * `county_id`, and filtering the queue by county is the first thing the office asks
   * for. Reshaping the view to carry it would be the cleaner fix, and would mean
   * touching a migration for a column that is already one join away.
   *
   * `days_overdue` is negative for a site that is not due yet. That is deliberate: the
   * same 7,266 rows answer "what is late" and "what is coming up", and a queue holding
   * only the late half could not be scheduled from.
   */
  dueQueue: async (req: Request, res: Response) => {
    try {
      const filterKey = String(req.query.filter || 'overdue');
      if (!(filterKey in DUE_FILTERS) && filterKey !== 'all') {
        return res.status(400).json({
          success: false,
          message: `filter must be one of: ${Object.keys(DUE_FILTERS).join(', ')}, all`,
        });
      }
      const countyId = intParam(req.query.county_id);
      const { limit, offset } = paging(req);
      const clause = filterKey === 'all' ? 'TRUE' : DUE_FILTERS[filterKey];

      // SCH-15: a booked site is planned work, not work to plan, so the default
      // queue says nothing about sites a future day already owns. They are not
      // gone — `show_scheduled=1` reads them back with the day and driver that
      // has them, which is the difference between hiding a row and silently
      // deleting a pump-out.
      const showScheduled = ['1', 'true', 'yes'].includes(String(req.query.show_scheduled ?? '').toLowerCase());

      // SCH-15/sorting: the queue is read two ways — by urgency (the default,
      // soonest-due first) and by customer, when the office is working a
      // single route or account. Whitelisted; the ORDER BY column is
      // interpolated, so nothing outside this map may reach the SQL.
      const DUE_SORTS: Record<string, string> = {
        due: 'q.effective_due_date',
        cust: 'q.legacy_cust_number',
        site: 'q.site_address',
        payer: 'q.payer_label',
        overdue: 'q.days_overdue',
      };
      const parsed = parseSort(req.query, DUE_SORTS, 'due', 'asc');
      if ('error' in parsed) {
        return res.status(400).json({ success: false, message: parsed.error });
      }
      const sort = parsed.sort;

      const rows = await AppDataSource.query(
        `SELECT q.property_id, q.legacy_cust_number, q.payer_label, q.site_address,
                q.site_city, p.county_id, q.status,
                to_char(q.next_service_due, 'YYYY-MM-DD')    AS next_service_due,
                to_char(q.effective_due_date, 'YYYY-MM-DD')  AS effective_due_date,
                q.adjusted, q.adjustment_reason,
                to_char(q.scheduled_on, 'YYYY-MM-DD')        AS scheduled_on,
                q.scheduled_status, q.scheduled_driver,
                q.days_overdue,
                COUNT(*) OVER() AS total_rows
           FROM v_due_queue q
           JOIN properties p ON p.id = q.property_id
          WHERE ${clause} AND ($1::int IS NULL OR p.county_id = $1)
            AND ($2::boolean OR q.scheduled_on IS NULL)
          ORDER BY ${sort.column} ${sort.dir.toUpperCase()} NULLS LAST,
                   q.legacy_cust_number ASC NULLS LAST
          LIMIT $3 OFFSET $4`,
        [countyId, showScheduled, limit, offset],
      );

      const total = rows.length ? Number(rows[0].total_rows) : 0;
      for (const r of rows) delete r.total_rows;

      // Counted apart from the page so the UI can show "1,925 overdue" rather than
      // "1,925 rows on this page", which is the number that actually drives a day.
      // "1,925 overdue" has to mean the number of sites whose pump-out is
      // actually late and nobody has booked it — the headline the office acts
      // on. Booked ones wait for their day; that number is the same count of
      // what the default page would show.
      const overdue = await AppDataSource.query(
        `SELECT COUNT(*)::int AS n,
                to_char(business_today(), 'YYYY-MM-DD') AS today
           FROM v_due_queue
          WHERE days_overdue > 0 AND scheduled_on IS NULL`,
      );

      return res.json({
        success: true,
        data: rows,
        meta: {
          filter: filterKey, county_id: countyId, total, limit, offset,
          sort: String(req.query.sort ?? 'due'), dir: sort.dir,
          overdue_total: overdue[0].n,
          show_scheduled: showScheduled,
          // The screen must be able to say what today is — a queue of due
          // dates is only legible next to the clock they are measured from
          // (P10, made visible).
          business_today: overdue[0].today,
        },
      });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, message: 'Due queue failed', error: internalError(error) });
    }
  },

  /**
   * GET /api/properties?status=&county_id=&page=&limit=
   *
   * The directory. `status` defaults to everything rather than to 'active', because a
   * sealed or unknown site is exactly the kind of thing the office searches for, and a
   * list that hides it looks like one that lost it.
   */
  getAll: async (req: Request, res: Response) => {
    try {
      const status = ['active', 'inactive', 'sealed', 'unknown'].includes(String(req.query.status))
        ? String(req.query.status)
        : null;
      const countyId = intParam(req.query.county_id);
      const { limit, offset } = paging(req);

      const rows = await AppDataSource.query(
        `SELECT p.id, p.legacy_cust_number, p.payer_label, p.site_address, p.site_city,
                p.site_state, p.site_zip, p.county_id, p.status, p.permit_number,
                p.service_interval_days,
                to_char(p.last_service_date, 'YYYY-MM-DD')  AS last_service_date,
                to_char(p.next_service_due, 'YYYY-MM-DD')   AS next_service_due,
                COUNT(*) OVER() AS total_rows
           FROM properties p
          WHERE ($1::property_status IS NULL OR p.status = $1::property_status)
            AND ($2::int IS NULL OR p.county_id = $2)
          ORDER BY p.legacy_cust_number NULLS LAST
          LIMIT $3 OFFSET $4`,
        [status, countyId, limit, offset],
      );
      const total = rows.length ? Number(rows[0].total_rows) : 0;
      for (const r of rows) delete r.total_rows;
      return res.json({ success: true, data: rows, meta: { total, limit, offset } });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, message: 'Property list failed', error: internalError(error) });
    }
  },

  /**
   * GET /api/properties/:id
   *
   * One site as the office reads it: the system, its tanks, who pays now, and the last
   * ten things that happened to it. Four queries rather than one join, because a
   * property has many tanks and many events and a single join would multiply the two
   * into a cartesian product that has to be unpicked in JavaScript.
   *
   * The owner is the row with no `ownership_end`, not the most recent one: legacy kept
   * one owner column and overwrote it, so recency is what the old app meant by current
   * and it is wrong whenever a back-dated sale is entered.
   */
  getById: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) {
        return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      }

      const prop = await loadProperty(id);
      if (!prop) {
        return res.status(404).json({ success: false, message: 'Property not found' });
      }

      const [tanks, owner, events] = await Promise.all([
        AppDataSource.query(
          `SELECT id, sequence_no, role, capacity_gallons, has_filter, raw_text
             FROM tanks WHERE property_id = $1 ORDER BY sequence_no`,
          [id],
        ),
        AppDataSource.query(
          `SELECT po.id, po.payer_id, po.is_primary, po.source,
                  coalesce(y.org_name, trim(coalesce(y.first_name,'') || ' ' || coalesce(y.last_name,''))) AS payer_name,
                  y.phone, y.email,
                  to_char(po.ownership_start, 'YYYY-MM-DD') AS ownership_start
             FROM property_ownerships po
             JOIN payers y ON y.id = po.payer_id
            WHERE po.property_id = $1 AND po.ownership_end IS NULL
            ORDER BY po.is_primary DESC, po.id DESC`,
          [id],
        ),
        AppDataSource.query(
          `SELECT e.id,
                  to_char(e.service_date, 'YYYY-MM-DD') AS service_date,
                  e.status, e.gallons_pumped, e.source, e.cert_unresolved,
                  trim(coalesce(pm.first_name,'') || ' ' || coalesce(pm.last_name,'')) AS pumper,
                  ds.name AS disposal_site
             FROM service_events e
        LEFT JOIN pumpers pm ON pm.id = e.performed_by_pumper_id
        LEFT JOIN disposal_sites ds ON ds.id = e.disposal_site_id
            WHERE e.property_id = $1
            ORDER BY e.service_date DESC, e.id DESC
            LIMIT 10`,
          [id],
        ),
      ]);

      return res.json({ success: true, data: { ...prop, tanks, owners: owner, recent_events: events } });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, message: 'Property detail failed', error: internalError(error) });
    }
  },

  /**
   * POST /api/properties — add a site (SCH-11).
   *
   * The office takes on new customers; the site list cannot be a frozen
   * migration artifact. `site_address` is the one required field, and not for
   * tidiness — a site is a place a crew drives to, and a record without one is
   * a schedule that fails in a driveway. Everything else arrives when the
   * paperwork does: the row is born with no service date, and therefore no due
   * date, because `next_service_due` is arithmetic and there is nothing yet to
   * add to. That NULL is the correct answer, not a gap to fill in.
   *
   * The legacy customer number is optional and unique: crews radio it, so a
   * collision is refused by naming the number, and new app-built sites may
   * simply not have one.
   */
  create: async (req: Request, res: Response) => {
    try {
      const parsed = await validateFields(req.body);
      if (parsed.error) {
        return res.status(parsed.error[0]).json(parsed.error[1]);
      }
      const values = parsed.values!;
      if (typeof values.site_address !== 'string' || !values.site_address) {
        return res.status(400).json({
          success: false,
          message: 'site_address is required — a site a crew cannot find is not a site',
        });
      }

      const cols = Object.keys(values);
      const params = cols.map((c) => values[c]);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

      let created: Array<{ id: number }>;
      try {
        // The only UNIQUE on the table's face is legacy_cust_number; name it
        // back, because "duplicate key value" means nothing to a scheduler and
        // "number 3494 is already used" means everything.
        created = await AppDataSource.query(
          `INSERT INTO properties (${cols.join(', ')})
           VALUES (${placeholders})
           RETURNING id`,
          params,
        );
      } catch (error: any) {
        if (error?.code === '23505' && values.legacy_cust_number !== undefined) {
          return res.status(409).json({
            success: false,
            message: `Customer number ${values.legacy_cust_number} is already used by another site.`,
          });
        }
        throw error;
      }

      return res.status(201).json({ success: true, data: await loadProperty(created[0].id) });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, message: 'Property create failed', error: internalError(error) });
    }
  },

  /**
   * PATCH /api/properties/:id — a narrow edit (SCH-11).
   *
   * Only the columns the body names are in the UPDATE, and only columns on
   * the whitelist; `updated_at` is the one thing always set, because raw SQL
   * does not consult @UpdateDateColumn and an edit that leaves no timestamp
   * is a decision nobody can date later. A full-row save would clobber
   * whatever the ledger wrote between this request's read and its write — the
   * ledger does not pause for the office's form to load.
   *
   * There is still no DELETE on this surface, and that is the requirement:
   * `route_stops` and `tanks` cascade from a property, but `service_events`
   * restrict, and a site that was ever pumped cannot be un-pumped by deleting
   * its hub. The honest retire is `status = 'sealed' | 'inactive'` — a state
   * the queue stops offering, not a fact history loses.
   */
  update: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) {
        return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      }
      const parsed = await validateFields(req.body);
      if (parsed.error) {
        return res.status(parsed.error[0]).json(parsed.error[1]);
      }
      const values = parsed.values!;
      const cols = Object.keys(values);
      if (!cols.length) {
        return res.status(400).json({
          success: false,
          message: `No editable fields given. Send at least one of: ${Object.keys(EDITABLE).join(', ')}.`,
        });
      }

      const params = cols.map((c) => values[c]);
      params.push(id);
      const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');

      let out: unknown;
      try {
        out = await AppDataSource.query(
          `UPDATE properties
              SET ${sets}, updated_at = now()
            WHERE id = $${params.length}
            RETURNING id`,
          params,
        );
      } catch (error: any) {
        if (error?.code === '23505' && values.legacy_cust_number !== undefined) {
          return res.status(409).json({
            success: false,
            message: `Customer number ${values.legacy_cust_number} is already used by another site.`,
          });
        }
        throw error;
      }
      const [, rowCount] = out as unknown as [unknown, number];
      if (!rowCount) {
        return res.status(404).json({ success: false, message: `No site has id ${id}.` });
      }

      return res.json({ success: true, data: await loadProperty(id) });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, message: 'Property update failed', error: internalError(error) });
    }
  },

  /**
   * POST /api/properties/:id/due-adjustments  { adjusted_due_date, reason }
   *
   * SCH-16: the office's lawful way to disagree with a generated due date. The
   * generated column is never touched (SCH-11) — the overlay row is the
   * disagreement, and it must be able to stand on its own later: hence the
   * required reason and the attribution read off the token, never the body.
   *
   * Every refusal names the next thing the clerk needs, in the order they will
   * need it: today's date when they reached for the past (and the correction
   * route that past dates actually belong to — LED-01), and the open
   * adjustment's own date and reason when they are reaching for a second one.
   */
  createDueAdjustment: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) {
        return res.status(404).json({ success: false, message: `No site has id ${req.params.id}.` });
      }
      const rawDate = String((req.body ?? {}).adjusted_due_date ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        return res.status(400).json({
          success: false,
          message: 'adjusted_due_date must be a date in YYYY-MM-DD form.',
        });
      }
      const rawReason = String((req.body ?? {}).reason ?? '');
      if (!rawReason.trim()) {
        return res.status(400).json({
          success: false,
          message: 'A due-date adjustment has to say why — the reason is the record.',
        });
      }

      const props = await AppDataSource.query(
        `SELECT status FROM properties WHERE id = $1`, [id],
      );
      if (!props.length) {
        return res.status(404).json({ success: false, message: `No site has id ${id}.` });
      }
      if (props[0].status !== 'active') {
        return res.status(400).json({
          success: false,
          message: `That site is ${props[0].status}; it has no schedule to adjust.`,
        });
      }

      // The past is not a schedule question. A due date in the past is a claim
      // that the ledger's dates are wrong, and the ledger answers those with
      // new events (LED-01) — never with an overlay that quietly rewrites what
      // "due" meant yesterday.
      const today = await AppDataSource.query(
        `SELECT to_char(business_today(), 'YYYY-MM-DD') AS d`,
      );
      const businessToday = today[0].d;
      if (rawDate <= businessToday) {
        return res.status(400).json({
          success: false,
          message: `Today is ${businessToday}; an adjustment to ${rawDate} is not a `
            + 'schedule change, it is a claim about a service event. If the ledger is '
            + 'wrong, file a correction instead.',
        });
      }

      const open = await AppDataSource.query(
        `SELECT to_char(adjusted_due_date, 'YYYY-MM-DD') AS d, reason
           FROM due_date_adjustments
          WHERE property_id = $1 AND closed_at IS NULL`,
        [id],
      );
      if (open.length) {
        return res.status(409).json({
          success: false,
          message: `This site is already adjusted to ${open[0].d}: `
            + `"${open[0].reason}". Close that adjustment first.`,
        });
      }

      const userId = (req.user as { userId: number }).userId;
      const made = await AppDataSource.query(
        `WITH ins AS (
             INSERT INTO due_date_adjustments
                 (property_id, adjusted_due_date, reason, created_by)
             VALUES ($1, $2::date, $3, $4)
             RETURNING id, property_id,
                       to_char(adjusted_due_date, 'YYYY-MM-DD') AS adjusted_due_date,
                       reason, created_by,
                       to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"MZ"') AS created_at
           )
         SELECT id, property_id, adjusted_due_date, reason, created_by, created_at FROM ins`,
        [id, rawDate, rawReason.trim(), userId],
      );

      return res.status(201).json({ success: true, data: made[0] });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, message: 'Due-date adjustment failed', error: internalError(error) });
    }
  },

  /**
   * DELETE /api/properties/:id/due-adjustments
   *
   * Closes the open adjustment — the overlay comes off and the generated date
   * stands again. Soft on purpose (closed_by/closed_at): "we no longer dispute
   * it" is itself history, and the row that recorded the competitor's pump is
   * evidence long after the date stopped mattering.
   */
  deleteDueAdjustment: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) {
        return res.status(404).json({ success: false, message: `No site has id ${req.params.id}.` });
      }
      // Same sentence as the POST: a mistyped id must hear "no such site", not
      // "not adjusted" — the first is a typo to fix, the second is a fact
      // about a site that exists, and the clerk cannot tell which they got.
      const props = await AppDataSource.query(
        `SELECT 1 FROM properties WHERE id = $1`, [id],
      );
      if (!props.length) {
        return res.status(404).json({ success: false, message: `No site has id ${id}.` });
      }

      const userId = (req.user as { userId: number }).userId;
      const closed = await AppDataSource.query(
        `WITH c AS (
             UPDATE due_date_adjustments
                SET closed_by = $2, closed_at = now()
              WHERE property_id = $1 AND closed_at IS NULL
              RETURNING id,
                        to_char(adjusted_due_date, 'YYYY-MM-DD') AS adjusted_due_date,
                        reason
           )
         SELECT id, adjusted_due_date, reason FROM c`,
        [id, userId],
      );
      if (!closed.length) {
        return res.status(404).json({
          success: false,
          message: 'This site is not adjusted; its due date is the plain schedule.',
        });
      }
      return res.json({ success: true, data: { id: closed[0].id, closed: true } });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, message: 'Due-date adjustment close failed', error: internalError(error) });
    }
  },
};
