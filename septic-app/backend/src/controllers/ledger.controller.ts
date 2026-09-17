import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';

const INT8_MAX = '9223372036854775807';

function bigParam(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && String(n).length <= 19 && BigInt(n) < BigInt(INT8_MAX)
    ? n : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function intParam(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

/**
 * The ledger after it became append-only (LED-01, LED-02).
 *
 * Two operations belong to an append-only table, and the whole point of 0020 is
 * that they are the ONLY two: insert a correction, and read. This file therefore
 * contains no UPDATE and no DELETE, and the database raises if anything else
 * tries. Both endpoints are office-gated: a driver does not decide that a
 * regulatory record was wrong (the same reasoning as quarantine writes), and the
 * state report is a company-wide regulatory aggregate, which no lost tablet
 * should be able to exfiltrate in one request.
 *
 * **The chain is the state.** An event is superseded iff another event names it
 * (`corrects_event_id`). No `is_superseded` column exists because a stored flag
 * is a fact that can disagree with the rows it describes, and the partial unique
 * index (one primary per property-day) plus the "correct the head or be refused"
 * rule below keep every chain linear and every chain with exactly one head. The
 * report reads heads; everything else in a chain is history with a reason.
 */

const EVENT_COLUMNS = `
  id, property_id, performed_by_pumper_id, cert_unresolved, cert_as_recorded,
  to_char(service_date, 'YYYY-MM-DD') AS service_date, status::text AS status,
  gallons_pumped, waste_type_id, waste_note, disposal_site_id, disposal_method,
  to_char(disposal_date, 'YYYY-MM-DD') AS disposal_date,
  dnr_permit_number, ph_before, ph_after, duration_minutes,
  county_form_date, source, client_uuid, corrects_event_id,
  to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;

/** Fields a correction may carry. Everything else about an event is identity or
 * server property, and identity is exactly what a correction must not change:
 * correcting a wrong date or wrong site is not correcting a record, it is
 * writing a different one. */
const CORRECTABLE = [
  'gallons_pumped', 'waste_type_id', 'waste_note', 'disposal_site_id',
  'disposal_method', 'disposal_date', 'dnr_permit_number', 'ph_before',
  'ph_after', 'duration_minutes',
] as const;

export const correctEvent = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const id = bigParam(req.params.id);
    if (id === null) {
      return res.status(404).json({ error: 'Event id must be a positive integer' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(body)
      .filter((k) => k !== 'note' && k !== 'corrected_by_note' && !(CORRECTABLE as readonly string[]).includes(k));
    if (unknown.length) {
      return res.status(400).json({
        error: `These fields are not correctable: ${unknown.join(', ')}. `
          + 'A correction fixes what was measured at the site; the property, the date and the person who did the work are identity, and changing those means the record describes a different event.',
        correctable: CORRECTABLE,
      });
    }

    const changed = Object.fromEntries(
      CORRECTABLE.map((k) => [k, body[k]]).filter(([, v]) => v !== undefined && v !== null),
    );
    const fieldNames = Object.keys(changed);
    if (!fieldNames.length) {
      return res.status(400).json({ error: 'A correction that corrects nothing is just a duplicate' });
    }

    // Field validation mirrors dispatch.controller's: a correction that trips a
    // CHECK or an FK is a client bug answered with the field's name, not with
    // Postgres' words (NF-11).
    if (changed.gallons_pumped !== undefined) {
      const g = Number(changed.gallons_pumped);
      if (!Number.isFinite(g) || g < 0 || g > 999999.9) {
        return res.status(400).json({ error: 'gallons_pumped must be a number between 0 and 999999.9' });
      }
    }
    for (const name of ['waste_type_id', 'disposal_site_id'] as const) {
      if (changed[name] !== undefined && bigParam(changed[name]) === null) {
        return res.status(400).json({ error: `${name} must be a positive integer` });
      }
    }
    for (const name of ['disposal_date', 'ph_before', 'ph_after', 'duration_minutes'] as const) {
      if (changed[name] === undefined) continue;
      if (name === 'disposal_date' && !DATE_RE.test(String(changed[name]))) {
        return res.status(400).json({ error: 'disposal_date must be YYYY-MM-DD' });
      }
      const n = Number(changed[name]);
      if (!Number.isFinite(n)) {
        return res.status(400).json({ error: `${name} must be a number` });
      }
      if (name.startsWith('ph_') && (n < 0 || n > 14)) {
        return res.status(400).json({ error: `${name} must be between 0 and 14` });
      }
    }

    const outcome = await AppDataSource.transaction(async (em) => {
      // The advisory lock is the same shape the completion path uses: the check
      // that :id is still the head and the insert that makes it not-the-head
      // are two statements, and a second corrector fits between them.
      await em.query(`SELECT pg_advisory_xact_lock(hashtext('ledger_correct:' || $1::text))`, [id]);

      const [original] = await em.query(
        `SELECT ${EVENT_COLUMNS} FROM septic_app.service_events WHERE id = $1`, [id],
      );
      if (!original) return { kind: 'not-found' } as const;

      const [head] = await em.query(
        `SELECT corrects_event_id FROM septic_app.service_events WHERE id = $1`, [id],
      );
      const [corrector] = await em.query(
        `SELECT id FROM septic_app.service_events WHERE corrects_event_id = $1 ORDER BY id DESC LIMIT 1`,
        [id],
      );
      if (corrector) return { kind: 'already-corrected', by: Number(corrector.id) } as const;

      // LED-03: the correction row is app-sourced, and the 0020 CHECK requires
      // an app row to name a site. A correction of a legacy row that never had
      // one must supply one — the office is declaring what the missing fact was,
      // and a correction that leaves it missing corrects nothing that mattered.
      const finalSite = changed.disposal_site_id ?? original.disposal_site_id;
      if (finalSite === null || finalSite === undefined) {
        return { kind: 'no-site' } as const;
      }
      if (finalSite !== null) {
        const [siteOk] = await em.query(
          `SELECT 1 FROM septic_app.disposal_sites WHERE id = $1`, [finalSite],
        );
        if (!siteOk) return { kind: 'unknown-site', value: finalSite } as const;
      }
      if (changed.waste_type_id !== undefined) {
        const [wtOk] = await em.query(
          `SELECT 1 FROM septic_app.waste_types WHERE id = $1`, [changed.waste_type_id],
        );
        if (!wtOk) return { kind: 'unknown-waste', value: changed.waste_type_id } as const;
      }

      /**
       * The correction is a full row, not a diff: it carries the original's
       * identity (property, date, pumper, cert fields) untouched and every
       * correctable field overridden-or-copied. The report counts heads only,
       * so the pair nets to the corrected value by construction — there is no
       * delta arithmetic anywhere in this system to get wrong.
       */
      const [event] = await em.query(
        `INSERT INTO septic_app.service_events
           (property_id, performed_by_pumper_id, cert_unresolved, cert_as_recorded,
            service_date, status, gallons_pumped, waste_type_id, waste_note,
            disposal_site_id, disposal_method, disposal_date, dnr_permit_number,
            ph_before, ph_after, duration_minutes, source, corrects_event_id)
         VALUES ($1,$2,$3,$4,$5::date,'completed',$6,$7,$8,$9,$10,$11::date,$12,$13,$14,$15,'app',$16)
         RETURNING ${EVENT_COLUMNS}`,
        [
          original.property_id, original.performed_by_pumper_id, original.cert_unresolved,
          original.cert_as_recorded, original.service_date,
          changed.gallons_pumped ?? original.gallons_pumped,
          changed.waste_type_id ?? original.waste_type_id,
          changed.waste_note ?? original.waste_note,
          finalSite,
          changed.disposal_method ?? original.disposal_method,
          changed.disposal_date ?? original.disposal_date,
          changed.dnr_permit_number ?? original.dnr_permit_number,
          changed.ph_before ?? original.ph_before,
          changed.ph_after ?? original.ph_after,
          changed.duration_minutes ?? original.duration_minutes,
          id,
        ],
      );
      return { kind: 'written', original, event } as const;
    });

    if (outcome.kind === 'not-found') {
      return res.status(404).json({ error: 'Service event not found' });
    }
    if (outcome.kind === 'already-corrected') {
      return res.status(409).json({
        error: `Event ${id} has already been corrected by event ${outcome.by}. Correct the current record, not the one it superseded — chains stay linear because the report counts heads, and two corrections of the same original would both be counted.`,
        current_head: outcome.by,
      });
    }
    if (outcome.kind === 'no-site') {
      return res.status(400).json({
        error: 'The event names no disposal site, and a correction of an app record must: supply disposal_site_id.',
        required: ['disposal_site_id'],
      });
    }
    if (outcome.kind === 'unknown-site') {
      return res.status(400).json({ error: `disposal_site_id ${outcome.value} does not exist` });
    }
    if (outcome.kind === 'unknown-waste') {
      return res.status(400).json({ error: `waste_type_id ${outcome.value} does not exist` });
    }

    res.status(201).json({
      event: outcome.event,
      supersedes: id,
      corrected_fields: fieldNames,
    });
  } catch (error) {
    res.status(500).json({ error: internalError(error) });
  }
};

/**
 * GET /api/ledger/report?from=YYYY-MM-DD&to=YYYY-MM-DD   (LED-02)
 *
 * Generated on demand from `service_events`, never from a stored tally — the
 * legacy `tblStateReports` stored counters, and P1's whole argument is that
 * tallies drift from their source silently. The price of generation is that
 * this reads 48k rows per call; at one state report per month, that is the
 * correct trade and the index on service_date makes it a non-event.
 *
 * What counts: rows with status 'completed' that nobody corrects (heads).
 * Cancelled heads are excluded — a report of services performed is not a report
 * of services considered — and superseded rows are excluded because their head
 * carries the corrected values in full.
 *
 * `events_without_gallons` is in the response because LED-04's promise is that
 * the gap is *visible*: a total that silently means "sum of the rows that
 * happened to measure something" is the tallies-drift failure mode in a new
 * costume.
 */
export const stateReport = async (req: Request, res: Response): Promise<unknown> => {
  try {
    let from = typeof req.query.from === 'string' ? req.query.from : '1900-01-01';
    let to = typeof req.query.to === 'string' ? req.query.to : '';
    if (!DATE_RE.test(from) || (to !== '' && !DATE_RE.test(to))) {
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
    }
    if (to === '') {
      const [today] = await AppDataSource.query(`SELECT to_char(business_today(), 'YYYY-MM-DD') AS d`);
      to = today.d;
    }
    if (from > to) {
      return res.status(400).json({ error: 'from must not be after to' });
    }

    const months = await AppDataSource.query(
      `WITH effective AS (
           SELECT e.* FROM septic_app.service_events e
            WHERE e.status = 'completed'
              AND e.service_date BETWEEN $1::date AND $2::date
              AND NOT EXISTS (
                SELECT 1 FROM septic_app.service_events c
                 WHERE c.corrects_event_id = e.id)
         )
         SELECT to_char(date_trunc('month', service_date), 'YYYY-MM') AS month,
                count(*)::int                                        AS events,
                count(*) FILTER (WHERE gallons_pumped IS NULL)::int  AS events_without_gallons,
                coalesce(sum(gallons_pumped), 0)                     AS gallons
           FROM effective
          GROUP BY 1
          ORDER BY 1`,
      [from, to],
    );

    const bySite = await AppDataSource.query(
      `WITH effective AS (
           SELECT e.* FROM septic_app.service_events e
            WHERE e.status = 'completed'
              AND e.service_date BETWEEN $1::date AND $2::date
              AND NOT EXISTS (
                SELECT 1 FROM septic_app.service_events c
                 WHERE c.corrects_event_id = e.id)
         )
         SELECT to_char(date_trunc('month', service_date), 'YYYY-MM') AS month,
                s.id::int                                            AS disposal_site_id,
                coalesce(s.name, 'not recorded')                     AS disposal_site,
                count(*)::int                                        AS events,
                count(*) FILTER (WHERE gallons_pumped IS NULL)::int  AS events_without_gallons,
                coalesce(sum(e.gallons_pumped), 0)                   AS gallons
           FROM effective e
           LEFT JOIN septic_app.disposal_sites s ON s.id = e.disposal_site_id
          GROUP BY 1, 2, 3
          ORDER BY 1, gallons DESC, disposal_site`,
      [from, to],
    );

    const totals = months.reduce((acc, m: any) => ({
      events: acc.events + m.events,
      events_without_gallons: acc.events_without_gallons + m.events_without_gallons,
      gallons: (Number(acc.gallons) + Number(m.gallons)).toFixed(1),
    }), { events: 0, events_without_gallons: 0, gallons: '0.0' });

    res.json({
      report: 'service_events',
      generated: 'from service_events at request time; no stored tally exists',
      from, to, months, by_site: bySite, totals,
    });
  } catch (error) {
    res.status(500).json({ error: internalError(error) });
  }
};

/**
 * The ledger as a page, scoped to one site (the property screen's history tab).
 *
 * Deliberately not a general event search: everything the office does *with*
 * an event — correcting it — starts from "the history of this site", and an
 * unscoped search endpoint over the regulatory table would be a different
 * product with different rules. Superseded heads are included and *labelled*,
 * because an office that cannot see the superseded row cannot verify the
 * correction against it; the report endpoint's exclusion rule (heads only)
 * stays where the arithmetic happens.
 */
export const listEvents = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const propertyId = intParam(req.query.property_id);
    if (propertyId === null) {
      return res.status(400).json({ error: 'property_id must be a positive integer' });
    }
    const [prop] = await AppDataSource.query(
      `SELECT 1 FROM septic_app.properties WHERE id = $1`, [propertyId]);
    if (!prop) return res.status(404).json({ error: 'Property not found' });

    const rows = await AppDataSource.query(
      `SELECT e.id, e.service_date, e.status::text AS status, e.gallons_pumped,
              e.source, e.waste_note, e.dnr_permit_number, e.cert_as_recorded,
              e.corrects_event_id,
              wt.name AS waste_type, ds.name AS disposal_site,
              pu.first_name AS pumper_first, pu.last_name AS pumper_last,
              EXISTS (SELECT 1 FROM septic_app.service_events c
                       WHERE c.corrects_event_id = e.id) AS superseded
         FROM septic_app.service_events e
         LEFT JOIN septic_app.waste_types wt ON wt.id = e.waste_type_id
         LEFT JOIN septic_app.disposal_sites ds ON ds.id = e.disposal_site_id
         LEFT JOIN septic_app.pumpers pu ON pu.id = e.performed_by_pumper_id
        WHERE e.property_id = $1
        ORDER BY e.service_date DESC, e.id DESC
        LIMIT 100`,
      [propertyId],
    );
    return res.json({ success: true, data: rows });
  } catch (error) {
    return res.status(500).json({ error: internalError(error) });
  }
};

/**
 * The two lookup lists a correction form needs.
 *
 * One endpoint returning both, because they are always opened together (the
 * correction dialog) and both are tiny: a form that typed waste-type and
 * disposal-site ids by hand would be a machine for inventing references —
 * exactly the disease BIL-01 quarantined on the billing side.
 */
export const ledgerLookups = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const [wasteTypes, disposalSites] = await Promise.all([
      AppDataSource.query(
        `SELECT id, name, is_dnr_permitted FROM septic_app.waste_types
          ORDER BY is_dnr_permitted DESC NULLS LAST, name`),
      AppDataSource.query(
        `SELECT id, name, dnr_permit_no, accepts_slurry FROM septic_app.disposal_sites
          ORDER BY name`),
    ]);
    return res.json({ success: true, data: { waste_types: wasteTypes, disposal_sites: disposalSites } });
  } catch (error) {
    return res.status(500).json({ error: internalError(error) });
  }
};


/**
 * DRV-20: a service record with no route behind it.
 *
 * The route is the plan; the truck finds the work. A competitor's customer
 * calls the driver directly, an overflow day runs into tomorrow — the
 * pump-out is real, the state report needs it, and the ledger must not
 * depend on the office having predicted it. So this door exists, and it is
 * the capture endpoint's own discipline wearing different clothes:
 *
 *  - the server's day (`service_date` in the body is refused by name —
 *    DRV-08's sentence, restated for a second door so the next person who
 *    wonders "should this one be different?" finds the same answer already
 *    written here);
 *  - the login's pumper link and nothing else, warned-about when absent;
 *  - a disposal site demanded the way `done` demands it, because the state
 *    report is assembled by site;
 *  - gallons accepted-or-flagged, never accepted-or-quiet (LED-04);
 *  - `client_uuid` dedup, because the phone that submits from a ditch is a
 *    normal condition of this field, not an edge case (DRV-13);
 *  - and the pointer (SCH-16): the site's `last_service_date` moves in the
 *    same transaction, because a filed record that leaves the queue nagging
 *    tomorrow is a record the office will learn not to trust.
 *
 * What it deliberately is not: a stop, a route, or an invoice. A ledger row
 * that auto-billed would bill for work the customer may still be disputing
 * by phone; the office converts work into paperwork, not the other way round.
 */
const RECORD_SERVER_OWNED: readonly string[] = [
  'service_date', 'performed_by_pumper_id', 'source', 'status', 'corrects_event_id',
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 'YYYY-MM-DD';

export const recordServiceEvent = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const sent = RECORD_SERVER_OWNED.filter((k) => body[k] !== undefined);
    if (sent.length) {
      return res.status(400).json({
        success: false,
        message: `The server assigns ${sent.join(', ')}, so the request may not carry `
          + `${sent.length === 1 ? 'it' : 'them'}.`,
        server_owns: RECORD_SERVER_OWNED,
      });
    }

    const propertyId = intParam(body.property_id);
    if (propertyId === null) {
      return res.status(400).json({
        success: false, message: 'property_id must be a positive integer',
      });
    }

    let clientUuid: string | null = null;
    if (body.client_uuid !== undefined) {
      if (typeof body.client_uuid !== 'string' || !UUID_RE.test(body.client_uuid)) {
        return res.status(400).json({ success: false, message: 'client_uuid must be a uuid' });
      }
      clientUuid = body.client_uuid.toLowerCase();
    }

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
    if (disposalSiteId === null) {
      // The same sentence the Done tap gets — one rule, one wording, wherever
      // the load gets recorded from.
      return res.status(400).json({
        success: false,
        message: 'Recording a disposal needs to say where the waste went: disposal_site_id is required.',
        required: ['disposal_site_id'],
      });
    }

    const disposalMethod = typeof body.disposal_method === 'string' ? body.disposal_method : null;
    if (disposalMethod !== null && disposalMethod.length > 50) {
      return res.status(400).json({
        success: false, message: 'disposal_method must be 50 characters or fewer',
      });
    }
    const wasteNote = typeof body.waste_note === 'string' ? body.waste_note : null;

    const userId = Number((req.user as { userId?: number }).userId);

    type Outcome =
      | { kind: 'replay'; event: any }
      | { kind: 'no-site' }
      | { kind: 'no-ref'; name: string; value: number }
      | { kind: 'need-site' }
      | { kind: 'already-serviced'; propertyId: number; serviceDate: string;
          existingId: string; existingSource: string }
      | { kind: 'written'; event: any; serviceDate: string; pumperId: number | null };

    const outcome = await AppDataSource.transaction(async (em) => {
      const [prop] = (await em.query(
        `SELECT id FROM septic_app.properties WHERE id = $1`, [propertyId],
      )) as any[];
      if (!prop) return { kind: 'no-site' } as const;

      if (wasteTypeId !== null) {
        const [wt] = (await em.query(
          `SELECT id FROM septic_app.waste_types WHERE id = $1`, [wasteTypeId],
        )) as any[];
        if (!wt) return { kind: 'no-ref', name: 'waste_type_id', value: wasteTypeId } as const;
      }
      const [site] = (await em.query(
        `SELECT id FROM septic_app.disposal_sites WHERE id = $1`, [disposalSiteId],
      )) as any[];
      if (!site) return { kind: 'no-ref', name: 'disposal_site_id', value: disposalSiteId } as const;

      if (clientUuid) {
        // Read before anything is written: the retry must answer with the
        // first attempt's row — its date, its pumper — not a re-stamped twin.
        const [prior] = (await em.query(
          `SELECT ${EVENT_COLUMNS} FROM septic_app.service_events
            WHERE client_uuid = $1`, [clientUuid],
        )) as any[];
        if (prior) return { kind: 'replay', event: prior } as const;
      }

      const [who] = (await em.query(
        `SELECT pumper_id FROM septic_app.users WHERE id = $1`, [userId],
      )) as any[];

      const [today] = (await em.query(
        `SELECT to_char(business_today(), '${DAY}') AS d`,
      )) as any[];
      const serviceDate = today.d;

      // The (property, day) pair is one event, and two doors can open on it in
      // the same second: this form and a driver tapping Done. Same advisory
      // lock shape as the capture endpoint, so the check and the insert stay
      // one decision instead of a race the unique index resolves as a 500.
      await em.query(
        `SELECT pg_advisory_xact_lock(
            hashtext('service_event:' || $1::text || ':' || $2::text))`,
        [propertyId, serviceDate],
      );
      const [prior] = (await em.query(
        `SELECT id, source FROM septic_app.service_events
          WHERE property_id = $1 AND service_date = $2::date`,
        [propertyId, serviceDate],
      )) as any[];
      if (prior) {
        return {
          kind: 'already-serviced', propertyId, serviceDate,
          existingId: String(prior.id), existingSource: prior.source,
        } as const;
      }

      const [event] = (await em.query(
        `INSERT INTO septic_app.service_events
           (property_id, performed_by_pumper_id, service_date, status,
            gallons_pumped, waste_type_id, waste_note, disposal_site_id,
            disposal_method, source, client_uuid)
         VALUES ($1, $2, $3::date, 'completed', $4, $5, $6, $7, $8, 'app', $9)
         RETURNING ${EVENT_COLUMNS}`,
        [propertyId, who?.pumper_id ?? null, serviceDate, gallons,
         wasteTypeId, wasteNote, disposalSiteId, disposalMethod, clientUuid],
      )) as any[];

      // SCH-16's pointer, same transaction as the event it follows.
      await em.query(
        `UPDATE septic_app.properties
            SET last_service_date = GREATEST(
                  COALESCE(last_service_date, $2::date), $2::date)
          WHERE id = $1`,
        [propertyId, serviceDate],
      );

      return {
        kind: 'written', event, serviceDate,
        pumperId: who?.pumper_id ?? null,
      } as const;
    });

    if (outcome.kind === 'no-site') {
      return res.status(404).json({
        success: false, message: `No site has id ${propertyId}.`,
      });
    }
    if (outcome.kind === 'no-ref') {
      const label = outcome.name === 'waste_type_id' ? 'waste type' : 'disposal site';
      return res.status(400).json({
        success: false, message: `No ${label} has id ${outcome.value}.`,
      });
    }
    if (outcome.kind === 'replay') {
      return res.json({ success: true, replayed: true, data: outcome.event });
    }
    if (outcome.kind === 'already-serviced') {
      const legacy = outcome.existingSource === 'legacy_import';
      return res.status(409).json({
        success: false,
        message: legacy
          ? `Imported history already records a service at this site on ${outcome.serviceDate}. `
            + 'If that record is wrong, file a correction — a second event for the same day '
            + 'would be counted twice by the state report.'
          : `This site already has a service recorded today (event ${outcome.existingId}). `
            + 'If that record is wrong, correct it; do not file a second one.',
        existing_event_id: outcome.existingId,
      });
    }

    const warnings: string[] = [];
    if (outcome.pumperId === null) {
      warnings.push(
        'This service event has no pumper recorded: the login has no pumper link.',
      );
    }
    if (outcome.event.gallons_pumped === null) {
      warnings.push(
        'This service event records no gallons: it is filed and counted, and the state report lists it as an event without a measured volume.',
      );
    }
    return res.status(201).json({
      success: true,
      data: { ...outcome.event, business_today: outcome.serviceDate },
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: internalError(error) });
  }
};


/**
 * BIL-19: the billing queue — work the truck finished that nobody has billed.
 *
 * The office's question here is not "what happened?" (the ledger answers that)
 * but "what are we still owed?", and the two differ by exactly one join: an
 * event is billable while no `invoice_lines` row names it. Read from event
 * heads only — a superseded event is history with a reason, and billing the
 * original and its correction would invoice one truck afternoon twice, which
 * is the state report's own rule arriving at billing on time.
 *
 * The list is computed, never kept: attach an invoice line from any door —
 * the bid path, an adjustment, a hand-fix — and the event leaves the queue
 * because the same condition stopped being true, not because a sync job ran.
 */
const QUEUE_SORTS: Record<string, string> = {
  service_date: 'e.service_date',
  cust: 'p.legacy_cust_number',
  site: 'p.site_address',
  payer: 'p.payer_label',
};

export const unbilledEvents = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const rawDays = String(req.query.days ?? '60').toLowerCase();
    const allTime = rawDays === 'all';
    const days = allTime ? null : Number(rawDays);
    if (!allTime && (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 3650)) {
      return res.status(400).json({
        success: false,
        message: 'days must be an integer between 1 and 3650, or "all"',
      });
    }

    const sortKey = String(req.query.sort ?? 'service_date');
    if (!(sortKey in QUEUE_SORTS)) {
      return res.status(400).json({
        success: false,
        message: `sort must be one of: ${Object.keys(QUEUE_SORTS).join(', ')}`,
      });
    }
    const dir = String(req.query.dir ?? 'desc').toLowerCase();
    if (dir !== 'asc' && dir !== 'desc') {
      return res.status(400).json({ success: false, message: 'dir must be asc or desc' });
    }

    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 100;
    const rawPage = Number(req.query.page);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;

    // The invoice dialog asks "what does THIS site owe?": the same queue,
    // one site at a time.
    let propFilter: number | null = null;
    if (req.query.property_id !== undefined && req.query.property_id !== '') {
      const pid = Number(req.query.property_id);
      if (!Number.isInteger(pid) || pid <= 0) {
        return res.status(400).json({
          success: false, message: 'property_id must be a positive integer',
        });
      }
      propFilter = pid;
    }

    // Whitelisted fragments — the ORDER BY column is interpolated, so nothing
    // outside this map may reach the SQL, same doctrine as DUE_FILTERS.
    const orderCol = QUEUE_SORTS[sortKey];
    const nulls = sortKey === 'service_date' ? '' : ' NULLS LAST';

    const rows = await AppDataSource.query(
      `SELECT e.id AS service_event_id, e.property_id,
              p.legacy_cust_number, p.payer_label, p.site_address, p.site_city,
              p.county_id,
              (SELECT o.payer_id
                 FROM septic_app.property_ownerships o
                WHERE o.property_id = p.id
                  AND o.ownership_end IS NULL
                LIMIT 1) AS owner_payer_id,
              (SELECT case when coalesce(pa.org_name, '') <> ''
                              and trim(both from concat_ws(' ', pa.first_name, pa.last_name)) <> ''
                          then trim(both from concat_ws(' ', pa.first_name, pa.last_name))
                               || ' — ' || pa.org_name
                          else coalesce(nullif(pa.org_name, ''),
                                        trim(both from concat_ws(' ', pa.first_name, pa.last_name)))
                        end
                 FROM septic_app.property_ownerships o
                 JOIN septic_app.payers pa ON pa.id = o.payer_id
                WHERE o.property_id = p.id
                  AND o.ownership_end IS NULL
                LIMIT 1) AS owner_payer_name,
              to_char(e.service_date, 'YYYY-MM-DD') AS service_date,
              (business_today() - e.service_date)::int AS days_ago,
              e.gallons_pumped, e.source,
              wt.name AS waste_type, ds.name AS disposal_site,
              COUNT(*) OVER() AS total_rows
         FROM septic_app.service_events e
         JOIN septic_app.properties p ON p.id = e.property_id
         LEFT JOIN septic_app.waste_types wt ON wt.id = e.waste_type_id
         LEFT JOIN septic_app.disposal_sites ds ON ds.id = e.disposal_site_id
        WHERE e.status = 'completed'
          AND NOT EXISTS (                       -- heads only
            SELECT 1 FROM septic_app.service_events c
             WHERE c.corrects_event_id = e.id)
          AND NOT EXISTS (                       -- unbilled only
            SELECT 1 FROM septic_app.invoice_lines il
             WHERE il.service_event_id = e.id)
          AND ($1::int IS NULL OR e.service_date >= business_today() - $1::int)
          AND ($4::int IS NULL OR e.property_id = $4)
        ORDER BY ${orderCol} ${dir.toUpperCase()}${nulls}, e.id DESC
        LIMIT $2 OFFSET $3`,
      [days, limit, (page - 1) * limit, propFilter],
    );

    const total = rows.length ? Number(rows[0].total_rows) : 0;
    for (const r of rows) delete r.total_rows;

    const [clock] = await AppDataSource.query(
      `SELECT to_char(business_today(), 'YYYY-MM-DD') AS d`) as any[];

    return res.json({
      success: true,
      data: rows,
      meta: {
        total, limit, offset: (page - 1) * limit,
        days: allTime ? 'all' : days, sort: sortKey, dir,
        business_today: clock.d,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: internalError(error) });
  }
};
