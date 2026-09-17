import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';

/**
 * The driver's day, in one request — DRV-01.
 *
 * Rural jobsites. A per-stop fetch turns a one-request launch into thirteen, each of which can
 * fail alone, and a driver with two bars cannot tell which of the thirteen did. So everything
 * the app needs before it goes offline again comes back together: order, status, address, the
 * three field notes, the tank configuration in both spellings, the county in both spellings,
 * and the due date. Nothing here is allowed to become a second request.
 *
 * Four things worth defending.
 *
 *  - **"Today" is `business_today()`, never the wall clock.** The dev fixture is frozen at
 *    2024-12-02 and the machine is 635 days ahead of it. A query that asked the clock would
 *    return "no route today" for a route sitting in the table, and would look correct while
 *    doing it (P10). The response echoes the date it used, so a screen can say which day it is
 *    showing rather than letting a phone's clock imply one.
 *
 *  - **Whose day it is comes from the token.** There is no `?driver_id=` here, and adding one
 *    would turn a stolen tablet into a window onto every other driver's route. The office reads
 *    a specific day through `/api/routes/:id`, a different endpoint with a different role gate
 *    — so "whose day is this" has exactly one answer, and it is not a parameter.
 *
 *  - **Drafts are invisible.** A driver seeing a half-built day sees the office's mistakes, and
 *    a route the office can still edit under them is not a plan. Only `published` and
 *    `in_progress` cross this line (SCH-09).
 *
 *  - **No route is a 404 with a reason, not an empty list.** `quarantineService` already learned
 *    why: an empty list and a refused request look identical on a screen and mean opposite
 *    things. A driver who opens the app to an empty list will assume the office forgot them; a
 *    driver who reads "nothing published for you today" knows to wait or to call.
 *
 * The join back to `routes` is not sloppiness — `v_driver_dispatch` deliberately carries no
 * `driver_id`, because it is the payload of a day, not a query by driver. Filtering on the
 * login means the view stays what it is for.
 *
 * @see src/controllers/route.controller.ts for the writes that make a day exist.
 */

const INT4_MAX = 2_147_483_647;
function intParam(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= INT4_MAX ? n : null;
}

/**
 * Dates leave as the eight characters the database meant.
 *
 * node-postgres hands back a `date` as a JavaScript Date at *local* midnight, and JSON then
 * writes it as a UTC instant — so a site due on the 1st reads as due on the last day of the
 * previous month to anyone east of Greenwich and to nobody west of it. A bug that appears on
 * Mondays and never in the developer's timezone. Timestamps are left alone: an instant is
 * unambiguous in ISO form, and it is only the bare dates that lie.
 */
const DAY = 'YYYY-MM-DD';

/**
 * The four statuses a device may put on a stop, and the only four.
 *
 * `pending` is deliberately absent. It is the state a stop is born in, not a decision a
 * driver makes; putting a resolved stop back on the list is an office act, and the office
 * has `/api/routes/:id` for it. A truck that could un-resolve its own day could also erase
 * the fact that it had been there.
 */
const DEVICE_STATUSES: readonly string[] = ['arrived', 'done', 'no_access', 'skipped'];

/** Statuses after which the stop is finished for the day, and the route may close over it. */
const TERMINAL: readonly string[] = ['done', 'no_access', 'skipped'];

/**
 * Fields the server owns, refused rather than ignored if a request carries one.
 *
 * Ignoring them would be the quieter bug and the worse one. A client that sends
 * `service_date` it invented is broken, and if the server silently overwrote it the client
 * would stay broken forever while the ledger disagreed with the screen. DRV-08 is the
 * load-bearing entry here: a tablet three days behind writes a mis-dated row into a
 * regulatory ledger, every downstream consumer reads that column as fact, and nothing ever
 * notices — which is precisely the failure P10 exists to prevent.
 */
const SERVER_OWNED: readonly string[] = [
  'service_date', 'arrived_at', 'completed_at', 'resolved_at',
  'performed_by_pumper_id', 'source', 'property_id', 'route_id', 'sequence_no',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const dispatchController = {
  /**
   * GET /api/dispatch/today
   *
   * One query on the happy path. The empty path costs one more, for the date in the 404 body —
   * a request nobody is waiting on can afford to be two queries.
   */
  today: async (req: Request, res: Response) => {
    try {
      const driverId = intParam(req.user?.userId);
      if (!driverId) {
        return res.status(401).json({ success: false, message: 'Token carries no user id' });
      }

      const rows = await AppDataSource.query(
        `SELECT d.route_id,
                to_char(d.route_date, '${DAY}')  AS route_date,
                d.route_status::text             AS route_status,
                d.route_version,
                r.truck_label,
                u.id                             AS driver_id,
                u.first_name,
                u.last_name,
                d.stop_id,
                d.sequence_no,
                d.stop_status::text              AS stop_status,
                d.stop_version,
                d.arrived_at,
                d.completed_at,
                d.property_id,
                d.legacy_cust_number,
                d.payer_label,
                d.site_address,
                d.site_city,
                d.site_state,
                d.site_zip,
                d.county_name,
                d.county_raw,
                d.tank_location_note,
                d.jobsite_location_note,
                d.chamber_pump_note,
                d.system_condition_note,
                d.reminder_opt_out,
                to_char(d.next_service_due, '${DAY}') AS next_service_due,
                d.tanks
           FROM septic_app.routes r
           JOIN septic_app.users u ON u.id = r.driver_id
           JOIN septic_app.v_driver_dispatch d ON d.route_id = r.id
          WHERE r.driver_id = $1
            AND r.route_date = business_today()
            AND d.route_status IN ('published', 'in_progress')
          ORDER BY d.sequence_no`,
        [driverId],
      );

      if (!rows.length) {
        const [today] = await AppDataSource.query(
          `SELECT to_char(business_today(), '${DAY}') AS business_today`,
        );
        return res.status(404).json({
          success: false,
          message: 'Nothing published for you today',
          business_today: today?.business_today ?? null,
        });
      }

      const { route_id, route_date, route_status, route_version, truck_label,
              driver_id, first_name, last_name } = rows[0];

      /**
       * The stop is spelled out rather than spread, because the view's row is a join of a
       * route and a stop and a property, and the route's fields are repeated on every line.
       * Lifting them into the header once and naming the stop fields explicitly is what keeps
       * the cached payload the PWA stores in IndexedDB the same shape on every launch — a
       * `...row` here would leak `route_id` onto thirteen stops and let the two spellings of
       * "which route am I on" drift apart the first time the view gained a column.
       */
      const stops = rows.map((r: Record<string, unknown>) => ({
        stop_id: r.stop_id,
        sequence_no: r.sequence_no,
        stop_status: r.stop_status,
        stop_version: r.stop_version,
        arrived_at: r.arrived_at,
        completed_at: r.completed_at,
        property_id: r.property_id,
        legacy_cust_number: r.legacy_cust_number,
        payer_label: r.payer_label,
        site_address: r.site_address,
        site_city: r.site_city,
        site_state: r.site_state,
        site_zip: r.site_zip,
        county_name: r.county_name,
        county_raw: r.county_raw,
        tank_location_note: r.tank_location_note,
        jobsite_location_note: r.jobsite_location_note,
        chamber_pump_note: r.chamber_pump_note,
        system_condition_note: r.system_condition_note,
        reminder_opt_out: r.reminder_opt_out,
        next_service_due: r.next_service_due,
        tanks: r.tanks,
      }));

      return res.json({
        success: true,
        data: {
          route_id,
          route_date,
          route_status,
          route_version,
          truck_label,
          business_today: route_date,
          driver: { id: driver_id, first_name, last_name },
          stop_count: stops.length,
          stops,
        },
      });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Dispatch lookup failed', error: internalError(error),
      });
    }
  },

  /**
   * PATCH /api/dispatch/stops/:id/status  { status, ...capture }
   *
   * DRV-06, DRV-07, DRV-08, DRV-09. The only write a driver's device makes, and the moment
   * the app stops being a viewer of the office's work and starts authoring the regulatory
   * record itself.
   *
   * **Whose stop it is comes from the token, and a stranger's stop is not merely forbidden,
   * it is not there.** The stop is read through its route and the route through the login, so
   * a stop on another driver's day answers 404 exactly as a nonexistent one does. That is
   * deliberate: 403 would confirm the id is real and that somebody else is working it, which
   * is a fact about a colleague's afternoon that a stolen tablet has no business revealing.
   *
   * **The server owns every clock in the row.** `service_date` is `business_today()`, the
   * timestamps are `now()`, and a body carrying either is refused by name above rather than
   * quietly overwritten (DRV-08).
   *
   * **`completed_at` means completed.** `no_access` and `skipped` get `resolved_at` and
   * nothing else, because stamping `completed_at` on a site nobody pumped would manufacture a
   * fact about where a truck was at 2pm. That distinction is why 0017 exists: DRV-06 asks for
   * four transitions timestamped, and 0007 only had columns for three of them.
   *
   * @see src/controllers/route.controller.ts for the office writes that put the stop here.
   */
  updateStop: async (req: Request, res: Response) => {
    try {
      const driverId = intParam(req.user?.userId);
      if (!driverId) {
        return res.status(401).json({ success: false, message: 'A login is required' });
      }
      const stopId = intParam(req.params.id);
      if (!stopId) {
        return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const asked = typeof body.status === 'string' ? body.status : '';
      if (!DEVICE_STATUSES.includes(asked)) {
        return res.status(400).json({
          success: false,
          message: `status must be one of ${DEVICE_STATUSES.join(', ')}. `
            + 'A stop cannot be put back to pending from a truck.',
        });
      }
      const status = asked;

      const sent = SERVER_OWNED.filter((k) => body[k] !== undefined);
      if (sent.length) {
        return res.status(400).json({
          success: false,
          message: `The server assigns ${sent.join(', ')}, so the request may not carry `
            + `${sent.length === 1 ? 'it' : 'them'}.`,
          server_owns: SERVER_OWNED,
        });
      }

      let clientUuid: string | null = null;
      if (body.client_uuid !== undefined) {
        if (typeof body.client_uuid !== 'string' || !UUID_RE.test(body.client_uuid)) {
          return res.status(400).json({ success: false, message: 'client_uuid must be a uuid' });
        }
        clientUuid = body.client_uuid.toLowerCase();
      }

      let expectedVersion: number | null = null;
      if (body.version !== undefined) {
        const v = Number(body.version);
        if (!Number.isInteger(v) || v < 0) {
          return res.status(400).json({ success: false, message: 'version must be a non-negative integer' });
        }
        expectedVersion = v;
      }
      /**
       * Capture fields are validated here rather than left to the database, because the
       * alternative is a foreign-key or check violation escaping as a 500 that names a table
       * (NF-11). The bound on `gallons_pumped` is `numeric(8,1)`, not taste.
       */
      let gallons: number | null = null;
      if (body.gallons_pumped !== undefined && body.gallons_pumped !== null
          && body.gallons_pumped !== '') {
        gallons = Number(body.gallons_pumped);
        if (!Number.isFinite(gallons) || gallons < 0 || gallons > 999999.9) {
          return res.status(400).json({
            success: false,
            message: 'gallons_pumped must be a number between 0 and 999999.9',
          });
        }
      }

      const wasteTypeId = body.waste_type_id == null
        ? null : intParam(body.waste_type_id);
      const disposalSiteId = body.disposal_site_id == null
        ? null : intParam(body.disposal_site_id);
      if (body.waste_type_id != null && wasteTypeId === null) {
        return res.status(400).json({
          success: false, message: 'waste_type_id must be a positive integer',
        });
      }
      if (body.disposal_site_id != null && disposalSiteId === null) {
        return res.status(400).json({
          success: false, message: 'disposal_site_id must be a positive integer',
        });
      }

      const disposalMethod = typeof body.disposal_method === 'string' ? body.disposal_method : null;
      if (disposalMethod !== null && disposalMethod.length > 50) {
        return res.status(400).json({
          success: false, message: 'disposal_method must be 50 characters or fewer',
        });
      }
      const wasteNote = typeof body.waste_note === 'string' ? body.waste_note : null;
      const outcome = await AppDataSource.transaction(async (em) => {
        /**
         * Parent first, then child — the order `route.controller.ts` already uses, so two
         * concurrent writers cannot take the same two locks in opposite orders and deadlock.
         */
        const [ref] = await em.query(
          `SELECT route_id FROM septic_app.route_stops WHERE id = $1`, [stopId],
        );
        if (!ref) return { kind: 'no-stop' } as const;

        const [route] = (await em.query(
          `SELECT r.id, r.driver_id, r.version, r.status::text AS status,
                  to_char(r.route_date, '${DAY}') AS route_date
             FROM septic_app.routes r
            WHERE r.id = $1
              FOR UPDATE`,
          [ref.route_id],
        )) as any[];

        // Somebody else's day is not a stop you are allowed to know the id of.
        if (!route || Number(route.driver_id) !== driverId) {
          return { kind: 'no-stop' } as const;
        }

        const [who] = (await em.query(
          `SELECT pumper_id FROM septic_app.users WHERE id = $1`, [driverId],
        )) as any[];

        /**
         * The replay, answered before anything is written. Read first, because the whole
         * value of `client_uuid` is that a retry returns the *first* attempt's timestamps —
         * without this read the replay would still be harmless to the data but would report a
         * fresh `arrived_at` that never happened.
         */
        if (clientUuid) {
          const [prior] = (await em.query(
            `SELECT id, status::text AS status, arrived_at, completed_at, resolved_at,
                    version, service_event_id
               FROM septic_app.route_stops
              WHERE client_uuid = $1`,
            [clientUuid],
          )) as any[];
          if (prior) return { kind: 'replay', stop: prior } as const;
        }

        const [stop] = (await em.query(
          `SELECT id, version, property_id, service_event_id, status::text AS status,
                  arrived_at, completed_at, resolved_at
             FROM septic_app.route_stops
            WHERE id = $1
              FOR UPDATE`,
          [stopId],
        )) as any[];
        if (!stop) return { kind: 'no-stop' } as const;

        /**
         * The order of these refusals is not arbitrary.
         *
         * The stop's own state is answered before the day's, because it is the truer and
         * more useful of the two. A one-stop day closes the moment its stop is worked, so
         * every later request about that stop would otherwise be told "a done route cannot
         * be worked from a truck" — a fact about the route, offered to a driver who asked
         * about a stop, and silent on the only thing they needed to know: that the stop is
         * already `skipped` and nothing further is required of them.
         *
         * `route-closed` still has real work to do, for the stop that is genuinely pending
         * on a day the office has unpublished or has not yet published.
         */
        if (TERMINAL.includes(stop.status)) {
          return { kind: 'already', status: stop.status } as const;
        }
        if (route.status !== 'published' && route.status !== 'in_progress') {
          return { kind: 'route-closed', status: route.status } as const;
        }
        if (expectedVersion !== null && Number(stop.version) !== expectedVersion) {
          return { kind: 'stale', found: Number(stop.version) } as const;
        }
        if (status === 'arrived' && stop.status !== 'pending') {
          return { kind: 'illegal', from: stop.status, to: status } as const;
        }

        for (const [name, value, table] of [
          ['waste_type_id', wasteTypeId, 'waste_types'],
          ['disposal_site_id', disposalSiteId, 'disposal_sites'],
        ] as const) {
          if (value === null) continue;
          // `table` is a literal from the array above and never a request value, which is the
          // only interpolation this file permits.
          const [ok] = await em.query(
            `SELECT 1 FROM septic_app.${table} WHERE id = $1`, [value],
          );
          if (!ok) return { kind: 'unknown-ref', name, value } as const;
        }

        /**
         * LED-03: marking a stop done is the assertion that a truck left a site
         * with less in it and a named place received what came out. Without the
         * site the row is a pump-out whose waste went nowhere, which is precisely
         * the number the state report exists to answer for.
         *
         * The refusal lives here, after the state-machine answers and the
         * reference checks, for an ordering reason: a stop that is already
         * terminal or on a closed route must still be told *that*, not be told
         * about a field it did not need to send because its write was already
         * dead. `no_access` and `skipped` write no event and need no site — the
         * asymmetry is the requirement.
         */
        if (status === 'done' && disposalSiteId === null) {
          return { kind: 'need-site' } as const;
        }
        /**
         * `service_date` is the server's date and nothing else (DRV-08). Note that it is
         * `business_today()` rather than `route.route_date`: the two agree on every route the
         * dispatch endpoint will hand out, but they are different questions — one is "what
         * date is it", the other is "what date was this day planned for" — and the ledger
         * records the former. A driver working past midnight writes the event on the day it
         * happened rather than the day the office typed.
         */
        const [today] = (await em.query(
          `SELECT to_char(business_today(), '${DAY}') AS d`,
        )) as any[];
        const serviceDate = today.d;

        let event: any = null;
        if (status === 'done') {
          /**
           * The pair the unique index is on, locked, because the check below and the insert
           * after it are two statements and a second driver can fit between them. Same shape
           * as SCH-08's advisory lock for the same reason: the index that would catch this
           * catches it by *rejecting the write*, which is the 500 DRV-09 exists to prevent.
           */
          await em.query(
            `SELECT pg_advisory_xact_lock(
                hashtext('service_event:' || $1::text || ':' || $2::text))`,
            [stop.property_id, serviceDate],
          );

          const [prior] = (await em.query(
            `SELECT id, source FROM septic_app.service_events
              WHERE property_id = $1 AND service_date = $2::date`,
            [stop.property_id, serviceDate],
          )) as any[];
          if (prior) {
            return {
              kind: 'already-serviced', property_id: stop.property_id,
              service_date: serviceDate, existing_id: prior.id, existing_source: prior.source,
            } as const;
          }

          /**
           * `performed_by_pumper_id` comes from the login's pumper link, never from the body.
           * It is nullable and the seeded dev driver has no link at all, so this legitimately
           * writes NULL — an anonymous row in a regulatory ledger. Refusing the completion
           * over it would punish the driver for an office gap and lose the pump-out
           * entirely, so the row is written and the response says so in `warnings`.
           */
          const [ev] = (await em.query(
            `WITH i AS (
                 INSERT INTO septic_app.service_events
                   (property_id, performed_by_pumper_id, service_date, status,
                    gallons_pumped, waste_type_id, waste_note, disposal_site_id,
                    disposal_method, source, client_uuid)
                 SELECT $1, $2, $3::date, 'completed', $4, $5, $6, $7, $8, 'app', $9
                 RETURNING id, service_date, gallons_pumped, source, status::text AS status,
                           performed_by_pumper_id, waste_type_id, disposal_site_id
               ) SELECT * FROM i`,
            [stop.property_id, who?.pumper_id ?? null, serviceDate, gallons,
             wasteTypeId, wasteNote, disposalSiteId, disposalMethod, clientUuid],
          )) as any[];
          if (!ev) throw new Error('service event insert returned no row');
          event = ev;

          /**
           * SCH-16 (capture half): the pump-out happened, so the due queue must
           * stop asking. `properties.last_service_date` is the pointer the
           * generated `next_service_due` reads, and until this migration it had
           * no writer at all in the app — every completed drive left the site
           * nagging the queue forever, which is exactly the noise that teaches
           * an office to skim the list. Same transaction as the event: an
           * event without its pointer is a ledger that disagrees with itself.
           *
           * GREATEST, not an assignment: completions arrive out of order — a
           * back-dated entry for last month must settle the past without
           * dragging the pointer backwards into it. A replay never reaches
           * this line (the dedup above returns the first attempt's row), and
           * the write is idempotent anyway, which is the kind of property a
           * driver's flaky queue appreciates.
           */
          await em.query(
            `UPDATE septic_app.properties
                SET last_service_date = GREATEST(
                      COALESCE(last_service_date, $2::date), $2::date)
              WHERE id = $1`,
            [stop.property_id, serviceDate],
          );
        }
        /**
         * One statement, and the CASE arms are the whole of DRV-06's honesty:
         *
         *  - `arrived_at` is COALESCEd, so re-marking arrival cannot move the clock of a
         *    driver who already tapped it.
         *  - `completed_at` is written by `done` and by nothing else.
         *  - `resolved_at` is written by all three terminal statuses.
         *  - `arrived_at` is *not* backfilled by `done`. A driver who completed a stop without
         *    tapping arrived was plainly there, but the server does not know when, and
         *    inventing an arrival equal to the completion would put a fabricated timestamp in
         *    the table the state report is built from. NULL means nobody tapped arrived,
         *    which is the truth.
         */
        const [written] = (await em.query(
          `WITH u AS (
               UPDATE septic_app.route_stops
                  SET status = $2::stop_status,
                      arrived_at   = CASE WHEN $2 = 'arrived'
                                          THEN COALESCE(arrived_at, now()) ELSE arrived_at END,
                      completed_at = CASE WHEN $2 = 'done'
                                          THEN now() ELSE completed_at END,
                      resolved_at  = CASE WHEN $2 IN ('done','no_access','skipped')
                                          THEN now() ELSE resolved_at END,
                      service_event_id = COALESCE($3::bigint, service_event_id),
                      client_uuid  = COALESCE($4::uuid, client_uuid),
                      version      = version + 1
                WHERE id = $1
                RETURNING id, status::text AS status, arrived_at, completed_at, resolved_at,
                          version, service_event_id, client_uuid
             ) SELECT * FROM u`,
          [stopId, status, event ? event.id : null, clientUuid],
        )) as any[];
        if (!written) throw new Error('stop update returned no row');

        /**
         * The day closes over its stops. `in_progress` on the first real transition — the
         * status and `started_at` that `enums.ts` said belonged to this slice — and `done`
         * once nothing is left to work. The predicate here is the *terminal* set, not the set
         * `uq_stop_one_open_route` excludes: `no_access` finishes a stop for the day yet
         * still holds the site's claim on the date, and those are different questions that
         * happen to look like one.
         */
        const [open] = (await em.query(
          `SELECT count(*)::int AS n FROM septic_app.route_stops
            WHERE route_id = $1 AND status <> ALL($2::stop_status[])`,
          [route.id, TERMINAL],
        )) as any[];

        let routeStatus: string = route.status;
        if (Number(open.n) === 0) routeStatus = 'done';
        else if (route.status === 'published') routeStatus = 'in_progress';

        let routeVersion: number = Number(route.version);
        if (routeStatus !== route.status) {
          const [r] = (await em.query(
            `WITH u AS (
                 UPDATE septic_app.routes
                    SET status = $2::route_status,
                        started_at   = COALESCE(started_at, now()),
                        completed_at = CASE WHEN $2 = 'done' THEN now() ELSE completed_at END,
                        version      = version + 1
                  WHERE id = $1
                  RETURNING version
               ) SELECT * FROM u`,
            [route.id, routeStatus],
          )) as any[];
          routeVersion = Number(r?.version ?? route.version);
        }

        return {
          kind: 'written', stop: written, event, service_date: serviceDate,
          route_status: routeStatus, route_version: routeVersion,
          pumper_id: who?.pumper_id ?? null,
        } as const;
      });
      if (outcome.kind === 'written' || outcome.kind === 'replay') {
        const written = outcome.stop;
        const warnings: string[] = [];
        if (outcome.kind === 'written' && outcome.event
            && outcome.pumper_id === null) {
          // Said out loud rather than left as a NULL somebody notices during an audit.
          warnings.push(
            'This service event has no pumper recorded: the login has no pumper link.',
          );
        }
        if (outcome.kind === 'written' && outcome.event
            && outcome.event.gallons_pumped === null) {
          // LED-04: two fifths of the legacy ledger has no gallons, so refusing a
          // no-gallons completion would have been refusing 40% of the business's
          // own history (P7). The row is filed, the gap is in the response, the
          // report counts it, and nobody has to discover it at an audit.
          warnings.push(
            'This service event records no gallons: it is filed and counted, and the state report lists it as an event without a measured volume.',
          );
        }
        return res.json({
          success: true,
          replayed: outcome.kind === 'replay',
          data: {
            stop: written,
            service_event: outcome.kind === 'written' ? outcome.event : null,
            business_today: outcome.kind === 'written' ? outcome.service_date : null,
            route_status: outcome.kind === 'written' ? outcome.route_status : null,
            route_version: outcome.kind === 'written' ? outcome.route_version : null,
          },
          ...(warnings.length ? { warnings } : {}),
        });
      }

      if (outcome.kind === 'no-stop') {
        // One message for "does not exist" and "is not yours", so the endpoint cannot be
        // used to find out which stop ids are real on somebody else's day.
        return res.status(404).json({
          success: false, message: 'No such stop on your day',
        });
      }

      if (outcome.kind === 'route-closed') {
        return res.status(409).json({
          success: false,
          message: `A ${outcome.status} route cannot be worked from a truck.`,
        });
      }

      if (outcome.kind === 'already') {
        return res.status(409).json({
          success: false,
          message: `This stop is already ${outcome.status}.`,
        });
      }

      if (outcome.kind === 'illegal') {
        return res.status(409).json({
          success: false,
          message: `A ${outcome.from} stop cannot be marked ${outcome.to}.`,
        });
      }

      if (outcome.kind === 'stale') {
        return res.status(409).json({
          success: false,
          message: 'Someone else changed this stop. Reload the day.',
          your_version: expectedVersion, current_version: outcome.found,
        });
      }

      if (outcome.kind === 'unknown-ref') {
        /**
         * Phrased as "no such thing" rather than "X does not exist", which is the wording the
         * leak scan in NF-11 exists to catch: `relation "septic_app.customers" does not exist`
         * is what every 500 in this app used to answer with. The phrasing is also clearer —
         * "waste_type_id does not exist" reads as a complaint about the schema, when the only
         * thing that is absent is the id the caller just sent.
         */
        const label = outcome.name === 'waste_type_id' ? 'waste type' : 'disposal site';
        return res.status(400).json({
          success: false, message: `No ${label} has id ${outcome.value}.`,
        });
      }

      if (outcome.kind === 'need-site') {
        return res.status(400).json({
          success: false,
          message: 'Marking a stop done records a disposal, so it must say where the waste went: disposal_site_id is required.',
          required: ['disposal_site_id'],
        });
      }

      /**
       * DRV-09. The same constraint violation, told apart by who owns the date — because the
       * two callers need opposite instructions. A driver who completed the stop twice needs a
       * message that says nothing more is required. A dispatcher whose route points at a
       * site the imported ledger already shows as serviced today needs to know the *route*
       * is wrong, which is not something a retry can fix and not something the raw
       * `duplicate key value violates unique constraint` would ever have conveyed.
       */
      const legacy = outcome.existing_source === 'legacy_import';
      return res.status(409).json({
        success: false,
        message: legacy
          ? `Imported history already records a service at this site on `
            + `${outcome.service_date}. The route needs reconciling with the ledger; this is `
            + `not something to retry.`
          : `This site was already serviced on ${outcome.service_date}.`,
        existing_service_event_id: outcome.existing_id,
        existing_source: outcome.existing_source,
        service_date: outcome.service_date,
      });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Stop update failed', error: internalError(error),
      });
    }
  },
};

