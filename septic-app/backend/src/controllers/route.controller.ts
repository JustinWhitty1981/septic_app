import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';

/**
 * Route composition — the office building a driver's day.
 *
 * For fifteen migrations this table could not be written to. `routes` existed since 0007,
 * `v_driver_dispatch` since 0010, and nothing in the application could put a row in either,
 * so the view that DRV-01 calls "the single launch query" had returned 0 rows since the day
 * it was created and `verify_schema.sql` reported `ok` about it every run. This file is the
 * write that makes the read mean something.
 *
 * Four things shape it.
 *
 * 1. **The office composes a day by hand; the system proposes nothing.**
 *
 *    No auto-assign, no computed stop order. P8: there are zero coordinates in the source
 *    and geocoding is a separate workstream, so any sequence the software produced would be
 *    fiction. And DATA_MODEL §13.8 measured that of the 1,925 properties the due queue calls
 *    overdue, only ~290 fell due inside the last year — the rest have not been pumped since
 *    before 2014 and are almost certainly systems Access carried forward and never closed.
 *    A planner pointed at that queue would build a route out of dead records. A human looking
 *    at the bands can see the difference. Recorded in DATA_MODEL §13 as a decision, not a default.
 *
 * 2. **The index that claims to prevent double-booking does not, so the endpoint does.**
 *
 *    0007 comments `uq_stop_one_open_route` with "A property should not sit on two live
 *    routes on the same day" and then builds it on `(property_id, route_id)`. Since `routes`
 *    is already `UNIQUE (route_date, driver_id)`, that key only stops a duplicate on the
 *    *same* route: two drivers on one date can both be sent to cust #3494 and the database
 *    will not object. It cannot be expressed as an index at all — `route_date` lives on the
 *    parent row, a partial index cannot reach a parent, and a generated column may only read
 *    its own row. So `addStop` takes a row lock on the route and an advisory lock on
 *    `(property_id, route_date)` and checks the rule itself. SCH-08.
 *
 * 3. **Every write is a transaction whose result is data, not an inference.**
 *
 *    The quarantine controller learned this the hard way: TypeORM returns `[rows, rowCount]`
 *    for a data-modifying statement, so `if (result.length)` is true whether the UPDATE
 *    matched a row or nothing, and every response said success.
 *
 *    **It was learned again here, in the same week.** The first working draft of this file
 *    wrote `UPDATE … RETURNING version` and read `const [r] = result` — which yields the rows
 *    *array*, not the row, so `r.version` was `undefined`, `Number(undefined)` was `NaN`, and
 *    every publish answered `"version": null` while the database quietly incremented it. The
 *    write was right and the report about it was wrong: the exact shape of the quarantine bug,
 *    reintroduced by somebody who had read the lesson and written it down in this very comment
 *    block. Which is the argument for the rule being a shape rather than a reminder.
 *
 *    So every write below is `WITH u AS ( …write… RETURNING … ) SELECT … FROM u`. The first
 *    keyword is WITH, TypeORM hands back ordinary rows, and the question "is this a tuple or a
 *    row" stops being a question. Where a transaction is genuinely needed the answer comes
 *    back as a discriminated `kind`, never as a boolean that could be lying.
 *
 *    One more, from the same draft: a data-modifying CTE is invisible to the statement that
 *    contains it. `quarantine.controller.ts` depends on that (it wants the row as it was
 *    *before* the update); `create` was broken by it (it wanted the row it had just made).
 *    Same rule, opposite consequences — see the comment on that endpoint.
 *
 * 4. **`version` is held by the reorder and nobody else.**
 *
 *    Publish and unpublish are single-row state transitions guarded by the status itself in
 *    the WHERE clause, which is already a lock — adding a version number there would ask the
 *    office to send a token for a change that cannot conflict. Reorder rewrites N rows, so it
 *    does (SCH-10): a stale write is refused rather than merged, because a merge would decide
 *    silently which driver's order survived.
 *
 * Errors go through `internalError` and never carry their own message (NF-11). The 4xx
 * responses do state their reason, and name the other route or the other driver when that is
 * what makes them actionable — a client-actionable refusal is not a leak, a constraint
 * violation from Postgres is.
 */

const INT4_MAX = 2_147_483_647;
function intParam(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= INT4_MAX ? n : null;
}

/**
 * A calendar date, or null. Validated in JavaScript rather than left to Postgres for two
 * reasons: `2024-02-30` is well-formed to a regex and comes back as `invalid input syntax
 * for type date`, which is a database error answering a client's typo; and the shape is
 * checked before any of it reaches a query.
 *
 * The round-trip through Date.UTC is what rejects the impossible days a regex cannot see.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dateParam(value: unknown): string | null {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? value : null;
}

/**
 * The route row a write starts from, locked.
 *
 * FOR UPDATE is not decoration. `sequence_no = max + 1` is only correct if nobody else is
 * computing the same max, and the publish/unpublish guards are only correct if the status
 * cannot change between reading it and writing it. Both are true under this lock and neither
 * is true without it.
 *
 * `stop_count` rides along because publish needs it and reading it after the lock is what
 * makes "published with zero stops" impossible rather than merely unlikely.
 */
type LockedRoute =
  | { kind: 'missing' }
  | {
      kind: 'locked'; id: number; route_date: string; status: string;
      version: number; stop_count: number;
    };

async function lockRoute(
  em: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> },
  id: number,
): Promise<LockedRoute> {
  const [r] = (await em.query(
    `SELECT id,
            to_char(route_date, 'YYYY-MM-DD') AS route_date,
            status::text                      AS status,
            version,
            (SELECT count(*) FROM septic_app.route_stops s
              WHERE s.route_id = routes.id)::int AS stop_count
       FROM septic_app.routes
      WHERE id = $1
        FOR UPDATE`,
    [id],
  )) as Array<Omit<Extract<LockedRoute, { kind: 'locked' }>, 'kind'>>;
  return r ? { kind: 'locked', ...r } : { kind: 'missing' };
}

export const routeController = {
  /**
   * GET /api/routes?date=YYYY-MM-DD
   *
   * One day of routes, which is the whole shape of the schedule: 2.34 active pumpers means
   * this is a list of lists, not a matrix.
   *
   * `date` defaults to the server's business today, never to the wall clock — the fixture is
   * frozen 635 days behind it, and a route that is sitting right there would read as an empty
   * day (P10). The response carries `business_today` so the screen can say which day it is
   * answering for instead of letting the browser's clock imply one.
   */
  forDate: async (req: Request, res: Response) => {
    try {
      const asked = req.query.date === undefined ? null : dateParam(req.query.date);
      if (req.query.date !== undefined && asked === null) {
        return res.status(400).json({ success: false, message: 'date must be YYYY-MM-DD' });
      }

      const rows = await AppDataSource.query(
        `SELECT r.id,
                to_char(r.route_date, 'YYYY-MM-DD') AS route_date,
                r.status::text                      AS status,
                r.version,
                r.truck_label,
                u.id                                AS driver_id,
                u.first_name,
                u.last_name,
                count(s.id)::int                                           AS stop_count,
                count(s.id) FILTER (WHERE s.status = 'pending')::int       AS pending_count,
                to_char(business_today(), 'YYYY-MM-DD')                 AS business_today
           FROM septic_app.routes r
           JOIN septic_app.users  u ON u.id = r.driver_id
      LEFT JOIN septic_app.route_stops s ON s.route_id = r.id
          WHERE r.route_date = COALESCE($1::date, business_today())
          GROUP BY r.id, r.route_date, r.status, r.version, r.truck_label,
                   u.id, u.first_name, u.last_name
          ORDER BY u.last_name, u.first_name, r.id`,
        [asked],
      );

      /**
       * `business_today` is returned beside the rows rather than only inside them, so an empty
       * day still answers the question. That is the case that needs it: a clerk looking at no
       * routes is about to create one, and the form has to know which date it is creating.
       * Reading it off `rows[0]` works right up until the day is empty, which is the one screen
       * state where it is load-bearing.
       */
      const [{ today }] = await AppDataSource.query(
        `SELECT to_char(business_today(), 'YYYY-MM-DD') AS today`,
      );

      return res.json({
        success: true, data: rows, meta: { date: asked, business_today: today },
      });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Route list failed', error: internalError(error),
      });
    }
  },

  /**
   * GET /api/routes/drivers
   *
   * The people who can be given a day. This exists because creating a route means naming a
   * driver, and until now the only way to name one was to already know a `users.id` — which
   * makes the endpoint unusable by the one role it was built for and fine to test by accident.
   *
   * `role = 'driver'` and `is_active`, not "every user": an office login should not be able to
   * put a truck on an accountant, and the alternative — validating the id server-side against
   * the role — produces a 400 that arrives after the clerk has already typed the address.
   *
   * Ordered by name because it is a list a person scans, and limited to the four columns a
   * picker needs. An email address is not required to choose who drives.
   */
  drivers: async (_req: Request, res: Response) => {
    try {
      const rows = await AppDataSource.query(
        `SELECT id, first_name, last_name, role::text AS role
           FROM septic_app.users
          WHERE role = 'driver' AND is_active
          ORDER BY last_name, first_name, id`,
      );
      return res.json({ success: true, data: rows });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Driver list failed', error: internalError(error),
      });
    }
  },

  /**
   * GET /api/routes/:id
   *
   * The day as the office built it, stops in order. Deliberately not the dispatch view: this
   * answers "what have I got planned" for a keyboard, and it has to show drafts, which a
   * driver must never see.
   */
  getById: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) {
        return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      }

      const [route] = await AppDataSource.query(
        `SELECT r.id,
                to_char(r.route_date, 'YYYY-MM-DD') AS route_date,
                r.status::text                      AS status,
                r.version,
                r.truck_label,
                r.created_at,
                u.id AS driver_id, u.first_name, u.last_name
           FROM septic_app.routes r
           JOIN septic_app.users  u ON u.id = r.driver_id
          WHERE r.id = $1`,
        [id],
      );
      if (!route) {
        return res.status(404).json({ success: false, message: 'Route not found' });
      }

      const stops = await AppDataSource.query(
        `SELECT s.id, s.sequence_no, s.status::text AS status, s.version,
                p.id AS property_id, p.legacy_cust_number, p.payer_label,
                p.site_address, p.site_city,
                c.name AS county_name, p.county_raw,
                to_char(p.next_service_due, 'YYYY-MM-DD') AS next_service_due,
                (SELECT count(*) FROM septic_app.tanks t
                  WHERE t.property_id = p.id)::int AS tank_count
           FROM septic_app.route_stops s
           JOIN septic_app.properties  p ON p.id = s.property_id
      LEFT JOIN septic_app.counties    c ON c.id = p.county_id
          WHERE s.route_id = $1
          ORDER BY s.sequence_no`,
        [id],
      );

      return res.json({ success: true, data: { ...route, stops } });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Route detail failed', error: internalError(error),
      });
    }
  },

  /**
   * POST /api/routes  { route_date, driver_id, truck_label? }
   *
   * One route per driver per date — that is the entire scheduling model, and
   * `UNIQUE (route_date, driver_id)` is what enforces it. A second attempt is not a failure
   * to hide: the response names the route that already exists so the office can open it
   * rather than guess its id.
   *
   * The driver is checked before the insert. Left to the foreign key, a typo'd id would
   * arrive as a violation message the client must never see (NF-11); checked first, it is a
   * 404 that says which of the two things was not found.
   */
  create: async (req: Request, res: Response) => {
    try {
      const date = dateParam(req.body?.route_date);
      if (!date) {
        return res.status(400).json({ success: false, message: 'route_date must be YYYY-MM-DD' });
      }
      const driverId = intParam(req.body?.driver_id);
      if (!driverId) {
        return res.status(400).json({ success: false, message: 'driver_id must be a positive integer' });
      }
      const truck = typeof req.body?.truck_label === 'string'
        ? req.body.truck_label.trim().slice(0, 30) || null
        : null;

      const [driver] = await AppDataSource.query(
        `SELECT id, first_name, last_name, is_active, role::text AS role
           FROM septic_app.users WHERE id = $1`,
        [driverId],
      );
      if (!driver) {
        return res.status(404).json({ success: false, message: 'Driver not found' });
      }
      /**
       * The same rule `/routes/drivers` applies when it builds the picker, enforced here so the
       * picker is not the only thing holding the line. A list filtered four ways and validated
       * none is a UI convention, not a rule: the endpoint has to refuse the request that skips
       * it, or the filter is decorative and the first client that is not this screen — a script,
       * a stale bookmark, a retry of a request somebody edited — puts a truck on an accountant.
       */
      if (driver.role !== 'driver') {
        return res.status(409).json({
          success: false,
          message: `${driver.first_name} ${driver.last_name} is ${driver.role}, not a driver. `
            + `Only accounts with the driver role can be given a day.`,
        });
      }
      if (!driver.is_active) {
        return res.status(409).json({
          success: false,
          message: `${driver.first_name} ${driver.last_name}'s account is disabled and cannot be routed`,
        });
      }

      /**
       * Insert-or-report, in one statement — but read it carefully, because this shape has a
       * trap in it that the quarantine controller's version does not.
       *
       * A data-modifying CTE runs against the snapshot the statement started on, and its
       * effects are **not visible to the rest of that statement**. 0011-era code in
       * `quarantine.controller.ts` relies on that: it selects the row as it was *before* the
       * UPDATE, which is exactly what a "somebody already closed this" response needs.
       *
       * Here the same rule is the bug. The first version of this selected the route from
       * `routes` after the insert CTE, and the insert succeeded — the row was in the table —
       * while the select beside it saw the pre-insert snapshot, returned nothing, and the
       * endpoint answered 500 about a route it had just created. Measured, not theorised.
       *
       * So every value below comes from a scalar subquery, and the one that must see the new
       * row reads it out of `i` rather than out of the table. `COALESCE` then covers both
       * outcomes with one statement: the id from the insert if there was one, or the id of the
       * row that already existed — which the snapshot *can* see, because it was there before
       * this statement began.
       *
       * No FROM clause means exactly one row back, so "no row" is no longer a state that has
       * to be handled.
       */
      const [row] = await AppDataSource.query(
        `WITH i AS (
             INSERT INTO septic_app.routes (route_date, driver_id, truck_label)
             VALUES ($1, $2, $3)
             ON CONFLICT (route_date, driver_id) DO NOTHING
             RETURNING id
         )
         SELECT (SELECT count(*) FROM i)::int AS created,
                COALESCE(
                  (SELECT id FROM i),
                  (SELECT id FROM septic_app.routes
                    WHERE route_date = $1 AND driver_id = $2)
                ) AS id,
                (SELECT version FROM septic_app.routes
                  WHERE route_date = $1 AND driver_id = $2) AS version,
                (SELECT status::text FROM septic_app.routes
                  WHERE route_date = $1 AND driver_id = $2) AS status,
                (SELECT truck_label FROM septic_app.routes
                  WHERE route_date = $1 AND driver_id = $2) AS truck_label`,
        [date, driverId, truck],
      );

      if (!row || row.id === null) {
        // Only reachable if the insert and the conflict both missed, which means the row is
        // gone from under a statement that just wrote it. Worth a 500.
        throw new Error(`route upsert produced no id for driver ${driverId}`);
      }

      if (Number(row.created) === 0) {
        return res.status(409).json({
          success: false,
          message: `${driver.first_name} ${driver.last_name} already has a route on ${date}`,
          route_id: row.id,
          status: row.status,
        });
      }

      return res.status(201).json({
        success: true,
        data: { id: row.id, route_date: date, status: 'draft', version: 0, truck_label: truck },
      });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Route create failed', error: internalError(error),
      });
    }
  },

  /**
   * POST /api/routes/:id/stops  { property_id }
   *
   * SCH-08, and the reason this is a transaction rather than a statement.
   *
   * Two locks, in this order, and the order is the deadlock story:
   *
   *   1. the route row (FOR UPDATE) — so two appends to one day cannot both compute max+1
   *   2. an advisory lock on (property_id, route_date) — the pair no index can reach
   *   3. then the reads, then the write
   *
   * The route lock first, because that is the contention that actually exists: two people
   * editing one day. The advisory lock is what makes the double-booking check honest —
   * without it, two office users adding the same site to two different drivers' days both
   * read "not routed" and both write.
   *
   * The clash check deliberately does not exclude the current route. One query answers both
   * questions — already on this route, or on somebody else's — and the second is the one the
   * index in 0007 would never have caught.
   */
  addStop: async (req: Request, res: Response) => {
    try {
      const routeId = intParam(req.params.id);
      if (!routeId) {
        return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      }
      const propertyId = intParam(req.body?.property_id);
      if (!propertyId) {
        return res.status(400).json({ success: false, message: 'property_id must be a positive integer' });
      }

      const outcome = await AppDataSource.transaction(async (em) => {
        const locked = await lockRoute(em, routeId);
        if (locked.kind === 'missing') return { kind: 'no-route' } as const;
        if (locked.status !== 'draft') {
          return { kind: 'not-draft', status: locked.status } as const;
        }

        /**
         * The pair no index can reach, locked. `hashtext` (one argument, returns int4) — not
         * `hashtextextended`, which takes (text, bigint) and does not exist in the shape the
         * first draft of this line assumed.
         *
         * A hash collision here costs two unrelated bookings a wait, not a double-booking: the
         * check below is the thing that decides, and the lock only makes the gap between
         * reading and writing small enough to trust.
         */
        await em.query(
          `SELECT pg_advisory_xact_lock(hashtext('route_stop:' || $1::text || ':' || $2::text))`,
          [propertyId, locked.route_date],
        );

        const [prop] = await em.query(
          `SELECT id FROM septic_app.properties WHERE id = $1`,
          [propertyId],
        );
        if (!prop) return { kind: 'no-property' } as const;

        const [clash] = await em.query(
          `SELECT s.route_id, s.status::text AS stop_status,
                  r.status::text AS route_status,
                  to_char(r.route_date, 'YYYY-MM-DD') AS route_date,
                  u.first_name, u.last_name
             FROM septic_app.route_stops s
             JOIN septic_app.routes r ON r.id = s.route_id
             JOIN septic_app.users  u ON u.id = r.driver_id
            WHERE s.property_id = $1
              AND r.route_date = $2::date
              AND s.status NOT IN ('done', 'skipped')
            LIMIT 1`,
          [propertyId, locked.route_date],
        );
        if (clash) {
          return { kind: 'clash', clash, same: Number(clash.route_id) === routeId } as const;
        }

        /**
         * The sequence comes from a scalar subquery, not from putting the aggregate in the
         * insert's own FROM clause. The two look equivalent and are not: `SELECT $1, $2,
         * max(x) FROM route_stops WHERE route_id = $1` is fine on an empty route only because
         * an aggregate with no GROUP BY always yields one row — a fact subtle enough that the
         * version which reads as more obvious is the one that silently inserts nothing on the
         * first stop of a day. A scalar subquery has no such question to get wrong.
         */
        const [stop] = await em.query(
          `WITH i AS (
               INSERT INTO septic_app.route_stops (route_id, property_id, sequence_no)
               SELECT $1, $2,
                      COALESCE((SELECT max(sequence_no) FROM septic_app.route_stops
                                 WHERE route_id = $1), 0) + 1
               RETURNING id, sequence_no, status::text AS status
           )
           SELECT * FROM i`,
          [routeId, propertyId],
        );
        if (!stop) throw new Error('stop insert returned no row');
        return { kind: 'added', stop } as const;
      });

      if (outcome.kind === 'added') {
        return res.status(201).json({ success: true, data: outcome.stop });
      }
      if (outcome.kind === 'no-route') {
        return res.status(404).json({ success: false, message: 'Route not found' });
      }
      if (outcome.kind === 'no-property') {
        return res.status(404).json({ success: false, message: 'Property not found' });
      }
      if (outcome.kind === 'not-draft') {
        return res.status(409).json({
          success: false,
          message: `A ${outcome.status} route cannot be edited. Unpublish it first.`,
        });
      }

      const c = outcome.clash;
      return res.status(409).json({
        success: false,
        already_on_route_id: c.route_id,
        message: outcome.same
          ? 'This site is already on this route.'
          : `Already routed on ${c.route_date} to ${c.first_name} ${c.last_name} `
            + `(route ${c.route_id}). Remove it there first.`,
      });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Add stop failed', error: internalError(error),
      });
    }
  },

  /**
   * POST /api/routes/stops  { property_id, driver_id, route_date }
   *
   * SCH-13: a stop whose route is named by *(driver, date)* instead of by id — the
   * composer's inverse. A clerk standing on a site record is thinking "this one,
   * Tuesday, Marco"; making them leave the record, find the day, and come back is the
   * composer's shape, not theirs.
   *
   * Why an endpoint and not three client calls: the interesting failure is the SCH-08
   * clash, and a client that creates the day first discovers the clash *after* the
   * empty draft exists — every refused booking would leak a draft route for a driver
   * who never asked for one, and drafts are what the composer is made of, so nobody
   * would notice them piling up. Inside one transaction the refusal rolls the created
   * day back with it: a rejected booking leaves no trace.
   *
   * The locking discipline is `addStop`'s, unchanged, because it has to be: route row
   * first, then the advisory lock on `(property, route_date)` in the *same key format*.
   * A different key format here would be correct twice and wrong once — this endpoint
   * and `/:id/stops` double-booking each other while each stays internally clean.
   *
   * The find-or-create reuses `create`'s COALESCE-over-scalar-subquery statement,
   * snapshot caveat and all: two clerks creating the same driver's same day in the
   * same millisecond can still race to a 500 (the loser's subquery reads the snapshot
   * from before the winner's insert). Recorded, not fixed — fixing it means a
   * `pg_advisory_xact_lock` on (driver, date) that every ordinary day-create would
   * also pay for, for a race measured in microseconds between two office keyboards.
   */
  scheduleSite: async (req: Request, res: Response) => {
    try {
      const date = dateParam(req.body?.route_date);
      if (!date) {
        return res.status(400).json({ success: false, message: 'route_date must be YYYY-MM-DD' });
      }
      const driverId = intParam(req.body?.driver_id);
      if (!driverId) {
        return res.status(400).json({ success: false, message: 'driver_id must be a positive integer' });
      }
      const propertyId = intParam(req.body?.property_id);
      if (!propertyId) {
        return res.status(400).json({ success: false, message: 'property_id must be a positive integer' });
      }

      const [driver] = await AppDataSource.query(
        `SELECT id, first_name, last_name, is_active, role::text AS role
           FROM septic_app.users WHERE id = $1`,
        [driverId],
      );
      if (!driver) {
        return res.status(404).json({ success: false, message: 'Driver not found' });
      }
      if (driver.role !== 'driver') {
        return res.status(409).json({
          success: false,
          message: `${driver.first_name} ${driver.last_name} is ${driver.role}, not a driver. `
            + `Only accounts with the driver role can be given a day.`,
        });
      }
      if (!driver.is_active) {
        return res.status(409).json({
          success: false,
          message: `${driver.first_name} ${driver.last_name}'s account is disabled and cannot be routed`,
        });
      }

      const full = `${driver.first_name} ${driver.last_name}`;

      /**
       * Refusals must *roll the transaction back*, not merely describe themselves.
       * Returning a refusal kind from the callback commits it — and by the time a
       * clash is known, the insert-or-report above may already have created the day.
       * A clashing booking that leaves an empty draft behind is the exact bug this
       * endpoint was written to prevent, so every refusal throws this sentinel and
       * the catch below answers it. `create` above can afford to return 409 values
       * normally; it writes nothing when it refuses.
       */
      type Refusal = {
        kind: 'not-draft' | 'no-route' | 'no-property' | 'clash';
        status?: string;
        clash?: Record<string, string>;
        same?: boolean;
      };
      class Refused extends Error {
        constructor(readonly out: Refusal) {
          super('schedule-refused');
        }
      }

      let outcome:
        | { kind: 'added'; stop: { id: number; sequence_no: number; status: string }; routeId: number; created: boolean }
        | Refusal;
      try {
        outcome = await AppDataSource.transaction(async (em) => {
        /**
         * Insert-or-report, verbatim from `create` above, including the reason every
         * value is a scalar subquery (a data-modifying CTE's effects are invisible to
         * its own statement's snapshot — measured, not theorised). Here `created = 0`
         * is not a 409: naming the day *is* the request, so an existing day is the
         * expected answer as often as a new one.
         */
        const [row] = await em.query(
          `WITH i AS (
               INSERT INTO septic_app.routes (route_date, driver_id)
               VALUES ($1, $2)
               ON CONFLICT (route_date, driver_id) DO NOTHING
               RETURNING id
           )
           SELECT (SELECT count(*) FROM i)::int AS created,
                  COALESCE(
                    (SELECT id FROM i),
                    (SELECT id FROM septic_app.routes
                      WHERE route_date = $1 AND driver_id = $2)
                  ) AS id,
                  (SELECT status::text FROM septic_app.routes
                    WHERE route_date = $1 AND driver_id = $2) AS status`,
          [date, driverId],
        );
        if (!row || row.id === null) {
          throw new Error(`route upsert produced no id for driver ${driverId}`);
        }
        const routeId = Number(row.id);

        if (Number(row.created) === 0 && row.status !== 'draft') {
          throw new Refused({ kind: 'not-draft', status: row.status });
        }

        const locked = await lockRoute(em, routeId);
        if (locked.kind === 'missing') throw new Refused({ kind: 'no-route' });

        // Same key format as addStop's, deliberately — see the header. The two
        // endpoints must contend on one lock or they can book one site twice.
        await em.query(
          `SELECT pg_advisory_xact_lock(hashtext('route_stop:' || $1::text || ':' || $2::text))`,
          [propertyId, date],
        );

        const [prop] = await em.query(
          `SELECT id FROM septic_app.properties WHERE id = $1`,
          [propertyId],
        );
        if (!prop) throw new Refused({ kind: 'no-property' });

        const [clash] = await em.query(
          `SELECT s.route_id, s.status::text AS stop_status,
                  r.status::text AS route_status,
                  to_char(r.route_date, 'YYYY-MM-DD') AS route_date,
                  u.first_name, u.last_name
             FROM septic_app.route_stops s
             JOIN septic_app.routes r ON r.id = s.route_id
             JOIN septic_app.users  u ON u.id = r.driver_id
            WHERE s.property_id = $1
              AND r.route_date = $2::date
              AND s.status NOT IN ('done', 'skipped')
            LIMIT 1`,
          [propertyId, date],
        );
        if (clash) {
          throw new Refused({
            kind: 'clash',
            clash: clash as unknown as Record<string, string>,
            same: Number(clash.route_id) === routeId,
          });
        }

        const [stop] = await em.query(
          `WITH i AS (
               INSERT INTO septic_app.route_stops (route_id, property_id, sequence_no)
               SELECT $1, $2,
                      COALESCE((SELECT max(sequence_no) FROM septic_app.route_stops
                                 WHERE route_id = $1), 0) + 1
               RETURNING id, sequence_no, status::text AS status
           )
           SELECT * FROM i`,
          [routeId, propertyId],
        );
        if (!stop) throw new Error('stop insert returned no row');
        return { kind: 'added', stop, routeId, created: Number(row.created) === 1 };
        });
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        outcome = err.out;
      }

      if (outcome.kind === 'added') {
        return res.status(201).json({
          success: true,
          data: {
            ...outcome.stop,
            route_id: outcome.routeId,
            route_date: date,
            driver_id: driverId,
            // Whether this request made the day. The clerk should hear that they
            // just opened Tuesday for Marco, not discover it on the composer.
            route_created: outcome.created,
          },
        });
      }
      if (outcome.kind === 'not-draft') {
        return res.status(409).json({
          success: false,
          message: `${full} already has a ${outcome.status} route on ${date}. `
            + `Unpublish it before adding stops.`,
        });
      }
      if (outcome.kind === 'no-route') {
        return res.status(404).json({ success: false, message: 'Route not found' });
      }
      if (outcome.kind === 'no-property') {
        return res.status(404).json({ success: false, message: 'Property not found' });
      }

      const c = outcome.clash;
      return res.status(409).json({
        success: false,
        already_on_route_id: c.route_id,
        message: outcome.same
          ? 'This site is already on this route.'
          : `Already routed on ${c.route_date} to ${c.first_name} ${c.last_name} `
            + `(route ${c.route_id}). Remove it there first.`,
      });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Add stop failed', error: internalError(error),
      });
    }
  },

  /**
   * DELETE /api/routes/:id/stops/:stopId
   *
   * Only a stop nobody has driven to. The WHERE clause carries the whole rule
   * (`status = 'pending'`), so the write and the guard are one atomic thing rather than a
   * check that can go stale between reading and writing.
   *
   * The CTE exists for the same reason it exists in quarantine: zero rows updated has two
   * different meanings — "there is no such stop on this route" and "somebody already worked
   * that site" — and a person needs to hear them differently.
   */
  removeStop: async (req: Request, res: Response) => {
    try {
      const routeId = intParam(req.params.id);
      const stopId = intParam(req.params.stopId);
      if (!routeId || !stopId) {
        return res.status(400).json({
          success: false, message: 'id and stopId must be positive integers',
        });
      }

      const [row] = await AppDataSource.query(
        `WITH d AS (
             DELETE FROM septic_app.route_stops
              WHERE id = $2 AND route_id = $1 AND status = 'pending'
              RETURNING id
         )
         SELECT (SELECT count(*) FROM d)::int AS deleted,
                s.id, s.status::text AS status, s.sequence_no
           FROM (SELECT id, status, sequence_no
                   FROM septic_app.route_stops
                  WHERE id = $2 AND route_id = $1) s`,
        [routeId, stopId],
      );

      if (!row) {
        return res.status(404).json({ success: false, message: 'Stop not found on this route' });
      }
      if (Number(row.deleted) === 0) {
        return res.status(409).json({
          success: false,
          message: `This stop is ${row.status} and is part of the record. It cannot be removed.`,
        });
      }

      return res.json({ success: true, data: { id: row.id, removed: true } });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Remove stop failed', error: internalError(error),
      });
    }
  },

  /**
   * PATCH /api/routes/:id/stops  { stop_ids: [..], version }
   *
   * SCH-10. The order is the deliverable — a driver's day is ~4 stops peaking near 13 and the
   * sequence is the thing the office decided — so reordering is a first-class write, not a
   * client-side sort the next render throws away.
   *
   * Three properties, each deliberate:
   *
   *  - **The body must be the complete set.** A partial list would silently delete the stops
   *    it did not mention. Anything that is not exactly the current membership is a 400, and
   *    the message says which ids were missing or unknown rather than "invalid payload".
   *  - **One UPDATE, so a half-applied order cannot exist.** `unnest … WITH ORDINALITY`
   *    writes every position in a single statement; there is no moment at which stop 3 is
   *    also stop 1. That property cost a migration — see 0016, which makes the sequence
   *    constraint deferrable, because a unique index checked row by row rejects a reversal
   *    precisely *because* the statement is atomic.
   *  - **`version` is required, and a mismatch is refused rather than merged.** Two tablets
   *    open on one route is the normal condition. A merge would decide silently whose order
   *    survived; a 409 tells the second person to look at what the first one did.
   */
  reorder: async (req: Request, res: Response) => {
    try {
      const routeId = intParam(req.params.id);
      if (!routeId) {
        return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      }

      const raw: unknown = req.body?.stop_ids;
      if (!Array.isArray(raw) || raw.length === 0) {
        return res.status(400).json({
          success: false, message: 'stop_ids must be a non-empty array of stop ids',
        });
      }
      const ids = raw.map(Number);
      if (ids.some((n) => !Number.isInteger(n) || n <= 0 || n > INT4_MAX)) {
        return res.status(400).json({ success: false, message: 'stop_ids must all be positive integers' });
      }
      if (new Set(ids).size !== ids.length) {
        return res.status(400).json({ success: false, message: 'stop_ids contains a duplicate' });
      }

      /**
       * `intParam` refuses zero, and zero is the version every route is born with — so
       * reusing it here made the *first* reorder of a route's life impossible. A version is a
       * counter, not an identifier: it is allowed to be nothing yet.
       */
      const sent = Number(req.body?.version);
      if (!Number.isInteger(sent) || sent < 0) {
        return res.status(400).json({
          success: false,
          message: 'version is required — send the version the route had when you read it',
        });
      }
      const expected = sent;

      const outcome = await AppDataSource.transaction(async (em) => {
        const locked = await lockRoute(em, routeId);
        if (locked.kind === 'missing') return { kind: 'no-route' } as const;
        if (locked.status !== 'draft') {
          return { kind: 'not-draft', status: locked.status } as const;
        }
        if (locked.version !== expected) {
          return { kind: 'stale', found: locked.version } as const;
        }

        const current: Array<{ id: number | string }> = await em.query(
          `SELECT id FROM septic_app.route_stops WHERE route_id = $1`, [routeId],
        );
        const have = new Set(current.map((r) => Number(r.id)));
        const wanted = new Set(ids);
        const missing = [...have].filter((n) => !wanted.has(n));
        const unknown = ids.filter((n) => !have.has(n));
        if (missing.length || unknown.length) {
          return { kind: 'membership', missing, unknown } as const;
        }

        /**
         * The renumber is one statement, and one statement is what needs this line: a unique
         * index is checked row by row as it is written, so reversing a day collides with a
         * number some stop has not vacated yet. 0016 makes the constraint deferrable; this is
         * the only place that defers it, inside the transaction that earns it. The deferral
         * dies with the transaction either way.
         */
        await em.query(
          `SET CONSTRAINTS route_stops_route_id_sequence_no_key DEFERRED`,
        );
        await em.query(
          `UPDATE septic_app.route_stops s
              SET sequence_no = x.ord
            FROM unnest($2::int[]) WITH ORDINALITY AS x(id, ord)
            WHERE s.id = x.id AND s.route_id = $1`,
          [routeId, ids],
        );
        const [bumped] = await em.query(
          `WITH u AS (
               UPDATE septic_app.routes SET version = version + 1
                WHERE id = $1 RETURNING version
           )
           SELECT version FROM u`,
          [routeId],
        );
        return { kind: 'reordered', version: Number(bumped?.version) } as const;
      });

      if (outcome.kind === 'reordered') {
        return res.json({ success: true, data: { route_id: routeId, version: outcome.version } });
      }
      if (outcome.kind === 'no-route') {
        return res.status(404).json({ success: false, message: 'Route not found' });
      }
      if (outcome.kind === 'not-draft') {
        return res.status(409).json({
          success: false,
          message: `A ${outcome.status} route cannot be reordered. Unpublish it first.`,
        });
      }
      if (outcome.kind === 'stale') {
        return res.status(409).json({
          success: false,
          message: 'Somebody else changed this day. Reload it before reordering.',
          you_sent: expected,
          current_version: outcome.found,
        });
      }
      return res.status(400).json({
        success: false,
        message: 'stop_ids must name every stop on the route and nothing that is not on it',
        missing: outcome.missing,
        unknown: outcome.unknown,
      });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Reorder failed', error: internalError(error),
      });
    }
  },

  /**
   * POST /api/routes/:id/publish
   *
   * SCH-09. This is the transition the whole feature has been waiting on: until it existed,
   * `route_status` had two values and nothing could ever move a route out of the first one, so
   * the dispatch view had been returning zero rows since the day it was created.
   *
   * Publishing is the moment the day stops being a plan and becomes a thing somebody drives.
   * Two rules follow from that, and both are enforced here rather than in a form:
   *
   *  - **At least one stop.** An empty published route is a driver opening the app to a blank
   *    screen in a place with no signal, with no way to tell that the office simply forgot to
   *    finish the day. A 400 now costs one click; that costs a wasted trip.
   *  - **Already published is a success, not an error** — the rule `resolve` established. A
   *    double-click or a network retry must not report failure for something the user wanted
   *    and which is now true. The response says so, so the screen can be honest about it.
   *
   * No `version` in the body. The status is the guard: `WHERE status = 'draft'` under the row
   * lock means two people publishing at once produce one publish and one honest
   * `already_published`.
   */
  publish: async (req: Request, res: Response) => {
    try {
      const routeId = intParam(req.params.id);
      if (!routeId) {
        return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      }

      const outcome = await AppDataSource.transaction(async (em) => {
        const locked = await lockRoute(em, routeId);
        if (locked.kind === 'missing') return { kind: 'no-route' } as const;
        if (locked.status === 'published') {
          return { kind: 'already', version: locked.version, stop_count: locked.stop_count } as const;
        }
        if (locked.status !== 'draft') {
          return { kind: 'not-draft', status: locked.status } as const;
        }
        if (locked.stop_count === 0) return { kind: 'empty' } as const;

        const [r] = await em.query(
          `WITH u AS (
               UPDATE septic_app.routes SET status = 'published', version = version + 1
                WHERE id = $1 RETURNING version
           )
           SELECT version FROM u`,
          [routeId],
        );
        return {
          kind: 'published', version: Number(r?.version), stop_count: locked.stop_count,
        } as const;
      });

      if (outcome.kind === 'published') {
        return res.json({
          success: true,
          data: {
            route_id: routeId, status: 'published',
            version: outcome.version, stop_count: outcome.stop_count,
          },
        });
      }
      if (outcome.kind === 'already') {
        return res.json({
          success: true,
          data: {
            route_id: routeId, status: 'published', already_published: true,
            version: outcome.version, stop_count: outcome.stop_count,
          },
        });
      }
      if (outcome.kind === 'no-route') {
        return res.status(404).json({ success: false, message: 'Route not found' });
      }
      if (outcome.kind === 'empty') {
        return res.status(400).json({
          success: false,
          message: 'A route with no stops cannot be published. Add at least one site.',
        });
      }
      return res.status(409).json({
        success: false, message: `A ${outcome.status} route cannot be published.`,
      });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Publish failed', error: internalError(error),
      });
    }
  },

  /**
   * POST /api/routes/:id/unpublish
   *
   * The undo exists for the same reason `unresolve` does: one wrong click two screens deep
   * should not be permanent, and with no history an accidental publish is indistinguishable
   * from a deliberate one.
   *
   * But it stops at the edge of the truck. Once any stop has left `pending`, the day has
   * happened — a driver has arrived at a site and that timestamp is a record — and pulling the
   * route back into a draft would leave a driver holding a day the office no longer admits it
   * published. So unpublish refuses the moment work exists, and says how much.
   */
  unpublish: async (req: Request, res: Response) => {
    try {
      const routeId = intParam(req.params.id);
      if (!routeId) {
        return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      }

      const outcome = await AppDataSource.transaction(async (em) => {
        const locked = await lockRoute(em, routeId);
        if (locked.kind === 'missing') return { kind: 'no-route' } as const;
        if (locked.status === 'draft') {
          return { kind: 'already', version: locked.version } as const;
        }
        if (locked.status !== 'published') {
          return { kind: 'not-published', status: locked.status } as const;
        }

        const [worked] = await em.query(
          `SELECT count(*)::int AS n
             FROM septic_app.route_stops
            WHERE route_id = $1 AND status <> 'pending'`,
          [routeId],
        );
        if (Number(worked?.n) > 0) return { kind: 'worked', n: Number(worked.n) } as const;

        const [r] = await em.query(
          `WITH u AS (
               UPDATE septic_app.routes SET status = 'draft', version = version + 1
                WHERE id = $1 RETURNING version
           )
           SELECT version FROM u`,
          [routeId],
        );
        return { kind: 'unpublished', version: Number(r?.version) } as const;
      });

      if (outcome.kind === 'unpublished') {
        return res.json({
          success: true,
          data: { route_id: routeId, status: 'draft', version: outcome.version },
        });
      }
      if (outcome.kind === 'already') {
        return res.json({
          success: true,
          data: {
            route_id: routeId, status: 'draft', already_draft: true, version: outcome.version,
          },
        });
      }
      if (outcome.kind === 'no-route') {
        return res.status(404).json({ success: false, message: 'Route not found' });
      }
      if (outcome.kind === 'worked') {
        return res.status(409).json({
          success: false,
          message: `${outcome.n} stop${outcome.n === 1 ? '' : 's'} already worked. `
            + 'The day has started; it cannot be unpublished.',
        });
      }
      return res.status(409).json({
        success: false, message: `A ${outcome.status} route cannot be unpublished.`,
      });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Unpublish failed', error: internalError(error),
      });
    }
  },
};







