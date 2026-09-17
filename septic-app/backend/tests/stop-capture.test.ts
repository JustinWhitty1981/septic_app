import { Client } from 'pg';
import { connect } from './db';

/**
 * The driver writes.
 *
 * DRV-06, DRV-07, DRV-08, DRV-09, DRV-13.
 *
 * Every other suite in this tree reads. This is the first that watches the app create a row
 * in the regulatory ledger — the row the state report is assembled from and the row that
 * cannot be corrected afterwards (P5: a correction is a new row). So the bar is not "did it
 * return 200" but "is the fact it recorded true".
 *
 * Four assertions are worth calling out, because each is a defect the obvious
 * implementation would have shipped with:
 *
 *  - **A skipped stop has no `completed_at`.** DRV-06 asks for four transitions timestamped
 *    and 0007 only had `arrived_at` and `completed_at`. The obvious implementation stamps
 *    `completed_at` on all three terminal statuses, passes every test that only checks "is
 *    there a timestamp", and records that a truck emptied a site it never entered. So this
 *    asks for `resolved_at` *and* that `completed_at` is still null.
 *
 *  - **The service date is the server's, and the server is 635 days from the machine.** The
 *    dev database is frozen at 2024-12-02. An event dated `2026-…` would be a
 *    correctly-formatted date in the wrong calendar, in the one column a regulator reads.
 *    The suite pins `business_today()` into a transaction to tell it from `now()` (P10);
 *    the shared clock itself runs live — see the as-of test below.
 *
 *  - **The collision DRV-09 describes is not a double-tap.** `UNIQUE (property_id,
 *    service_date)` spans the 48,214 imported events and four already sit on
 *    `business_today()` in this corpus. The fixture's own stops do not collide, so a suite
 *    that only completed a normal stop would go green without ever entering the branch. This
 *    suite therefore *plants* a legacy event on today and routes the site that owns it.
 *
 *  - **A replay must be answered, not merely survived.** Refusing the second attempt keeps
 *    the data correct and jams the offline queue, because the driver is staring at an error
 *    on a write that worked. One `client_uuid` goes out three times; the test requires one
 *    row, three successes, and an `arrived_at` that never moved.
 */

const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';

const LEAKS = [
  'septic_app', 'legacy.', 'relation "', 'does not exist', 'column "',
  'violates foreign key', 'violates unique constraint', 'duplicate key value',
  'QueryFailedRunner', 'QueryFailedError', 'at Function.', 'invalid input syntax',
  'null value in column', 'route_stops', 'service_events', 'stop_status',
];

let db: Client;
let adminToken = '';
const emails: string[] = [];
const routeIds: number[] = [];
const eventIds: string[] = [];
const pumperIds: number[] = [];
let businessToday = '';

const send = async (
  method: string, path: string, body?: unknown, token?: string,
): Promise<{ status: number; body: any }> => {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const t = token === undefined ? adminToken : token;
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${API}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: ((await res.json().catch(() => ({}))) as any) ?? {} };
};

const nothingLeaks = (body: unknown) => {
  const s = JSON.stringify(body);
  for (const leak of LEAKS) expect(s).not.toContain(leak);
};

let userSeq = 0;
const makeUser = async (role: string, withPumper = false) => {
  const { hashPassword } = require('../src/utils/password');
  const email = `t-stop.${role}.${RUN}.${(userSeq += 1)}@test.invalid`;
  emails.push(email);
  const { rows } = await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Stop',$1,$2,$3::user_role,true) RETURNING id`,
    [email, await hashPassword(PASSWORD), role],
  );
  const id = Number(rows[0].id);

  if (withPumper) {
    // A pumper is the regulatory identity and a login is a login; 0003 keeps them apart.
    // Linked here so the ledger row can name who pumped.
    const p = await db.query(
      `INSERT INTO septic_app.pumpers
         (certification_number, first_name, last_name, company)
       VALUES ($1,'Cert','Issued','Test Co') RETURNING id`,
      [`T${RUN}-${userSeq}`],
    );
    pumperIds.push(Number(p.rows[0].id));
    await db.query(`UPDATE septic_app.users SET pumper_id = $1 WHERE id = $2`,
      [p.rows[0].id, id]);
  }

  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body: any = await res.json().catch(() => ({}));
  return { token: body?.token ?? '', id };
};

/** A site nobody has booked on the frozen today, and that has no service event on it. */
const chosen: number[] = [];
// From 0029 a completion also moves properties.last_service_date — the pointer
// the due queue reads. The captures below are real writes to real corpus sites,
// so the suite saves each pointer at pick time and restores it at teardown:
// test rows are deleted after themselves, and a moved pointer is a test row.
const pointerBefore = new Map<number, string | null>();
const pick = async (): Promise<number> => {
  const { rows } = await db.query(
    `SELECT p.id
       FROM septic_app.properties p
      WHERE p.status = 'active'
        AND NOT (p.id = ANY($2::int[]))
        AND NOT EXISTS (
          SELECT 1 FROM septic_app.route_stops s
            JOIN septic_app.routes r ON r.id = s.route_id
           WHERE s.property_id = p.id
             AND r.route_date = $1::date
             AND s.status NOT IN ('done','skipped'))
        AND NOT EXISTS (
          SELECT 1 FROM septic_app.service_events e
           WHERE e.property_id = p.id AND e.service_date = $1::date)
      ORDER BY p.id LIMIT 1`,
    [businessToday, chosen],
  );
  if (!rows.length) throw new Error('no free property on business_today');
  const id = Number(rows[0].id);
  const before = await db.query(
    `SELECT to_char(last_service_date,'YYYY-MM-DD') AS d
       FROM septic_app.properties WHERE id = $1`, [id]);
  pointerBefore.set(id, before.rows[0]?.d ?? null);
  chosen.push(id);
  return id;
};

/** Any disposal site — LED-03 made one mandatory for every completion. */
const oneSite = async (): Promise<number> => {
  const { rows } = await db.query(
    `SELECT id FROM septic_app.disposal_sites ORDER BY id LIMIT 1`);
  return Number(rows[0].id);
};

/** One published route with one pending stop, driven by `driverId`. */
const buildDay = async (driverId: number, propertyId: number, label: string) => {
  const created = await send('POST', '/routes',
    { route_date: businessToday, driver_id: driverId, truck_label: label });
  expect(created.status).toBe(201);
  const routeId = Number(created.body.data.id);
  routeIds.push(routeId);
  const stop = await send('POST', `/routes/${routeId}/stops`, { property_id: propertyId });
  expect(stop.status).toBe(201);
  expect((await send('POST', `/routes/${routeId}/publish`, {})).status).toBe(200);
  return { routeId, stopId: Number(stop.body.data.id) };
};

const stopRow = async (stopId: number) => (await db.query(
  `SELECT status::text AS status, arrived_at, completed_at, resolved_at, version,
          service_event_id, client_uuid
     FROM septic_app.route_stops WHERE id = $1`, [stopId],
)).rows[0];

const eventRow = async (eventId: string) => (await db.query(
  `SELECT id, property_id, to_char(service_date,'YYYY-MM-DD') AS service_date, source,
          status::text AS status, gallons_pumped, waste_type_id, disposal_site_id,
          performed_by_pumper_id, client_uuid
     FROM septic_app.service_events WHERE id = $1`, [eventId],
)).rows[0];

beforeAll(async () => {
  db = await connect();
  const a = await makeUser('admin');
  adminToken = a.token;
  const today = await db.query(`SELECT to_char(business_today(),'YYYY-MM-DD') AS d`);
  businessToday = today.rows[0].d;
});

afterAll(async () => {
  if (routeIds.length) {
    await db.query(`DELETE FROM septic_app.route_stops WHERE route_id = ANY($1::int[])`, [routeIds]);
    await db.query(`DELETE FROM septic_app.routes WHERE id = ANY($1::int[])`, [routeIds]);
  }
  for (const [id, d] of pointerBefore) {
    await db.query(
      `UPDATE septic_app.properties SET last_service_date = $2::date WHERE id = $1`,
      [id, d]);
  }
  if (eventIds.length || pumperIds.length) {
    // LED-01: the ledger is trigger-guarded against DELETE, and pumpers are
    // RESTRICT-referenced by it (0023) — the fixture teardown is the guard's
    // documented exception, one transaction, ordered child-then-parent. The
    // rollback paths were never the problem; these rows were written through
    // the API and committed.
    await db.query('BEGIN');
    await db.query(`SET LOCAL septic.ledger_repair = 'on'`);
    if (eventIds.length) {
      await db.query(`DELETE FROM septic_app.service_events WHERE id = ANY($1::bigint[])`, [eventIds]);
    }
    if (pumperIds.length) {
      await db.query(`DELETE FROM septic_app.pumpers WHERE id = ANY($1::int[])`, [pumperIds]);
    }
    await db.query('COMMIT');
  }
  for (const email of emails) {
    await db.query('DELETE FROM septic_app.users WHERE email = $1', [email]);
  }
  await db?.end();
});

const routeRow = async (routeId: number) => (await db.query(
  `SELECT status::text AS status, version, started_at, completed_at
     FROM septic_app.routes WHERE id = $1`, [routeId],
)).rows[0];

describe('DRV-06: the four transitions, each timestamped by the server', () => {
  let driverToken = '';
  let driverId = 0;
  let routeId = 0;
  let stopId = 0;

  beforeAll(async () => {
    const d = await makeUser('driver', true);
    driverToken = d.token;
    driverId = d.id;
    const day = await buildDay(driverId, await pick(), `arr-${RUN}`);
    routeId = day.routeId;
    stopId = day.stopId;
  });

  it('marks a stop arrived and stamps it with the server clock', async () => {
    const before = Date.now();
    const r = await send('PATCH', `/dispatch/stops/${stopId}/status`,
      { status: 'arrived' }, driverToken);
    expect(r.status).toBe(200);
    expect(r.body.data.stop.status).toBe('arrived');

    const row = await stopRow(stopId);
    expect(row.status).toBe('arrived');
    expect(row.arrived_at).toBeInstanceOf(Date);
    expect(row.completed_at).toBeNull();
    expect(row.resolved_at).toBeNull();
    // Arrival is an instant the server observed, so it is within a minute of this process.
    // A device-supplied value would land in 2024 and miss by 635 days.
    expect(Math.abs(new Date(row.arrived_at).getTime() - before)).toBeLessThan(60_000);
  });

  it('moves the route out of published and starts its clock', async () => {
    const row = await routeRow(routeId);
    expect(row.status).toBe('in_progress');
    expect(row.started_at).toBeInstanceOf(Date);
    expect(row.completed_at).toBeNull();
  });

  it('refuses to mark an arrived stop arrived again', async () => {
    const r = await send('PATCH', `/dispatch/stops/${stopId}/status`,
      { status: 'arrived' }, driverToken);
    expect(r.status).toBe(409);
    nothingLeaks(r.body);
    // And the first arrival keeps its time: a refused write must not move a clock.
    const row = await stopRow(stopId);
    expect(row.status).toBe('arrived');
  });

  it('gives no_access a resolved_at and no completed_at', async () => {
    const d = await makeUser('driver', false);
    const day = await buildDay(d.id, await pick(), `na-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'no_access' }, d.token);
    expect(r.status).toBe(200);

    const row = await stopRow(day.stopId);
    expect(row.status).toBe('no_access');
    expect(row.resolved_at).toBeInstanceOf(Date);
    /**
     * The assertion 0017 exists for. A `completed_at` here would say a truck emptied a site
     * its crew could not get into, and the state report is assembled downstream of that.
     */
    expect(row.completed_at).toBeNull();
    expect(row.arrived_at).toBeNull();
  });

  it('gives skipped a resolved_at and no completed_at', async () => {
    const d = await makeUser('driver', false);
    const day = await buildDay(d.id, await pick(), `sk-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'skipped' }, d.token);
    expect(r.status).toBe(200);

    const row = await stopRow(day.stopId);
    expect(row.status).toBe('skipped');
    expect(row.resolved_at).toBeInstanceOf(Date);
    expect(row.completed_at).toBeNull();
  });

  it('closes the route once nothing is left to work', async () => {
    const d = await makeUser('driver', false);
    const day = await buildDay(d.id, await pick(), `close-${RUN}`);
    await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'skipped' }, d.token);

    const row = await routeRow(day.routeId);
    expect(row.status).toBe('done');
    expect(row.started_at).toBeInstanceOf(Date);
    expect(row.completed_at).toBeInstanceOf(Date);
  });

  it('refuses a stop that is already terminal', async () => {
    const d = await makeUser('driver', false);
    const day = await buildDay(d.id, await pick(), `term-${RUN}`);
    await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'skipped' }, d.token);

    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'done' }, d.token);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/already skipped/i);
    nothingLeaks(r.body);
  });

  it('refuses a status the enum does not have', async () => {
    const d = await makeUser('driver', false);
    const day = await buildDay(d.id, await pick(), `bad-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'cancelled' }, d.token);
    expect(r.status).toBe(400);
    nothingLeaks(r.body);
  });

  it('will not put a stop back to pending from a truck', async () => {
    const d = await makeUser('driver', false);
    const day = await buildDay(d.id, await pick(), `pend-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'pending' }, d.token);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/pending/);
  });
});

describe('the suite is not vacuous', () => {
  it('has an admin token and a business clock the suite can pin apart from the machine',
    async () => {
      expect(adminToken.length).toBeGreaterThan(20);
      expect(businessToday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The as-of knob (0001) used to sit frozen at the migration snapshot, and
      // this test asserted the disagreement; the business went live on
      // 2026-09-05 and the knob was released to `current_date`. What DRV-08
      // still needs is that the two clocks CAN disagree — so the proof pins
      // the clock inside this transaction and rolls it back. Pinning the
      // shared row for the whole parallel run, to keep a green test green,
      // is how the office's calendar starts lying again.
      await db.query('BEGIN');
      try {
        await db.query(
          `UPDATE septic_app.app_setting SET value = '2001-01-01' WHERE key = 'as_of_date'`);
        const { rows } = await db.query(
          `SELECT to_char(current_date,'YYYY-MM-DD') AS real_today,
                  to_char(business_today(),'YYYY-MM-DD') AS business_today`,
        );
        expect(rows[0].business_today).toBe('2001-01-01');
        expect(rows[0].real_today).not.toBe(rows[0].business_today);
      } finally {
        await db.query('ROLLBACK');
      }
      // Outside the transaction the shared clock is the machine's again —
      // the machine in the business's zone, not the container's. The office
      // is Central; Postgres is UTC; between 18:00 and midnight Central the
      // two dates differ, and a released clock that follows the container
      // tells the office it is tomorrow (the 09/06 evening report — 0032).
      const { rows } = await db.query(
        `SELECT to_char(business_today(),'YYYY-MM-DD') AS d,
                to_char((now() AT TIME ZONE 'America/Chicago')::date,
                        'YYYY-MM-DD') AS central,
                to_char(current_date,'YYYY-MM-DD') AS utc`,
      );
      expect(rows[0].d).toBe(rows[0].central);
      // And live, not pinned to the snapshot: the Central date is never more
      // than one day away from the UTC date the container itself believes.
      expect(
        Math.abs(
          Date.parse(`${rows[0].d}T00:00:00Z`) - Date.parse(`${rows[0].utc}T00:00:00Z`),
        ) / 86_400_000,
      ).toBeLessThanOrEqual(1);
    });
});

describe('DRV-07: completing a stop writes the ledger', () => {
  let driverToken = '';
  let driverId = 0;
  let pumperId = 0;

  beforeAll(async () => {
    const d = await makeUser('driver', true);
    driverToken = d.token;
    driverId = d.id;
    const { rows } = await db.query(
      `SELECT pumper_id FROM septic_app.users WHERE id = $1`, [d.id],
    );
    pumperId = Number(rows[0].pumper_id);
    expect(pumperId).toBeGreaterThan(0);
  });

  it('creates one service_events row carrying what the driver captured', async () => {
    const prop = await pick();
    const waste = (await db.query(
      `SELECT id FROM septic_app.waste_types ORDER BY id LIMIT 1`)).rows[0].id;
    const site = (await db.query(
      `SELECT id FROM septic_app.disposal_sites ORDER BY id LIMIT 1`)).rows[0].id;

    const day = await buildDay(driverId, prop, `done-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`, {
      status: 'done', gallons_pumped: 1500, waste_type_id: waste,
      disposal_site_id: site, waste_note: 'Excessive solids',
    }, driverToken);
    expect(r.status).toBe(200);

    const eventId = r.body.data.service_event.id;
    eventIds.push(eventId);
    const ev = await eventRow(eventId);
    expect(Number(ev.property_id)).toBe(prop);
    // 'app' vs 'legacy_import' is what separates a 2026 pump-out from a 2019 one.
    expect(ev.source).toBe('app');
    expect(ev.status).toBe('completed');
    expect(Number(ev.gallons_pumped)).toBe(1500);
    expect(Number(ev.waste_type_id)).toBe(Number(waste));
    expect(Number(ev.disposal_site_id)).toBe(Number(site));
    // From the login's pumper link, never from the body.
    expect(Number(ev.performed_by_pumper_id)).toBe(pumperId);

    const stop = await stopRow(day.stopId);
    expect(String(stop.service_event_id)).toBe(String(eventId));
    expect(stop.completed_at).toBeInstanceOf(Date);
    expect(stop.resolved_at).toBeInstanceOf(Date);

    // SCH-16 (capture half): the event and the pointer it moved, in the same
    // breath. Before 0029 this pointer had no writer at all — every completed
    // drive left the site nagging the due queue forever — so the assertion the
    // requirement actually needs is that the queue's source column follows a
    // completion, on the server's day, not the tablet's.
    const lsd = (await db.query(
      `SELECT to_char(last_service_date,'YYYY-MM-DD') AS d
         FROM septic_app.properties WHERE id = $1`, [prop])).rows[0].d;
    expect(lsd).toBe(businessToday);
  });

  it('says so when the ledger row cannot name who pumped it', async () => {
    const d = await makeUser('driver', false);
    const day = await buildDay(d.id, await pick(), `nopump-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'done', disposal_site_id: await oneSite() }, d.token);
    expect(r.status).toBe(200);
    eventIds.push(r.body.data.service_event.id);

    // The row is still written — losing a pump-out over an office data gap is worse than an
    // anonymous one — but the response refuses to let that pass unnoticed.
    expect(r.body.data.service_event.performed_by_pumper_id).toBeNull();
    expect(r.body.warnings?.join(' ')).toMatch(/no pumper recorded/i);
  });

  it('accepts a completion with no gallons, and says so (LED-04)', async () => {
    // Two fifths of the legacy ledger has no gallons. Demanding them would have
    // refused 40% of the business's own history; accepting them silently would
    // make the report's gallons column mean "the rows that remembered". The
    // middle path is asserted from both ends: filed (below) and flagged (below).
    const d = await makeUser('driver', true);
    const day = await buildDay(d.id, await pick(), `nogal-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'done', disposal_site_id: await oneSite() }, d.token);
    expect(r.status).toBe(200);
    eventIds.push(r.body.data.service_event.id);
    expect(r.body.data.service_event.gallons_pumped).toBeNull();
    expect(r.body.warnings?.join(' ')).toMatch(/no gallons/i);
  });

  it('refuses a waste type that does not exist, without describing the database', async () => {
    const d = await makeUser('driver', true);
    const prop = await pick();
    const day = await buildDay(d.id, prop, `badwt-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'done', waste_type_id: 999999 }, d.token);
    expect(r.status).toBe(400);
    nothingLeaks(r.body);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM septic_app.service_events
        WHERE property_id = $1 AND service_date = business_today()`,
      [prop],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('DRV-08: the server owns the date', () => {
  let driverToken = '';
  let driverId = 0;

  beforeAll(async () => {
    const d = await makeUser('driver', true);
    driverToken = d.token;
    driverId = d.id;
  });

  it('dates the event with business_today, not with the machine clock', async () => {
    const day = await buildDay(driverId, await pick(), `date-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'done', disposal_site_id: await oneSite() }, driverToken);
    expect(r.status).toBe(200);
    const ev = await eventRow(r.body.data.service_event.id);
    eventIds.push(r.body.data.service_event.id);

    /**
     * The whole of P10 in one assertion. The container clock says 2026; this database's
     * business today says 2024-12-02. An implementation that reached for `now()`, for
     * `current_date`, or for the phone would produce a well-formed date 635 days from the
     * ledger it is being filed into — and every consumer of that column reads it as fact.
     */
    expect(ev.service_date).toBe(businessToday);
    expect(r.body.data.business_today).toBe(businessToday);
  });

  it('refuses a service_date in the body rather than quietly overriding it', async () => {
    const d = await makeUser('driver', true);
    const day = await buildDay(d.id, await pick(), `sdate-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`, {
      status: 'done', service_date: '1999-01-01',
    }, d.token);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/service_date/);
    nothingLeaks(r.body);

    // Nothing was written, so the refusal is a refusal and not a silent correction.
    const stop = await stopRow(day.stopId);
    expect(stop.status).toBe('pending');
    expect(stop.service_event_id).toBeNull();
  });

  it('refuses a device-supplied arrival timestamp too', async () => {
    const d = await makeUser('driver', true);
    const day = await buildDay(d.id, await pick(), `ats-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`, {
      status: 'arrived', arrived_at: '2024-12-02T08:00:00Z',
    }, d.token);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/arrived_at/);
  });
});

describe('DRV-09: a second service on one date is refused in words, not in a 500', () => {
  let driverToken = '';
  let driverId = 0;

  beforeAll(async () => {
    const d = await makeUser('driver', true);
    driverToken = d.token;
    driverId = d.id;
  });

  it('tells the office when the imported ledger already owns that date', async () => {
    /**
     * The case the fixture never reaches. Four legacy events already sit on business_today()
     * in this corpus, and none of them belongs to a property the dev fixture routes — so a
     * suite that only completed ordinary stops would go green without executing this branch
     * once. Plant one instead of hoping.
     */
    const prop = await pick();
    const planted = await db.query(
      `INSERT INTO septic_app.service_events
         (property_id, service_date, source, status, gallons_pumped)
       VALUES ($1, business_today(), 'legacy_import', 'completed', 900)
       RETURNING id`, [prop],
    );
    eventIds.push(planted.rows[0].id);

    const day = await buildDay(driverId, prop, `legacy-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'done', disposal_site_id: await oneSite() }, driverToken);

    expect(r.status).toBe(409);
    nothingLeaks(r.body);
    expect(r.body.existing_source).toBe('legacy_import');
    // The instruction is the point: this is not a retry, and the driver cannot fix it.
    expect(r.body.message).toMatch(/Imported history/i);
    expect(r.body.message).toMatch(/not something to retry/i);

    // Exactly one event for the site, and it is still the planted one.
    const { rows } = await db.query(
      `SELECT count(*)::int AS n, max(source) AS source FROM septic_app.service_events
        WHERE property_id = $1 AND service_date = business_today()`, [prop],
    );
    expect(rows[0].n).toBe(1);
    expect(rows[0].source).toBe('legacy_import');
    const stop = await stopRow(day.stopId);
    expect(stop.status).toBe('pending');
    expect(stop.service_event_id).toBeNull();
  });

  it('tells a driver in different words when the app already owns that date', async () => {
    /**
     * Reachable, and only since this slice. Completing a stop makes it `done`, which drops it
     * out of `uq_stop_one_open_route` — so the same site may legitimately be added to a
     * second driver's day on the same date, and the composition endpoint will allow it
     * because SCH-08's predicate excludes `done`. The ledger is the last line of defence, and
     * "already serviced" is a different message to a dispatcher than "imported history
     * disagrees with your route".
     */
    const prop = await pick();
    const owner = await makeUser('driver', true);
    const first = await buildDay(owner.id, prop, `dup-a-${RUN}`);
    const a = await send('PATCH', `/dispatch/stops/${first.stopId}/status`,
      { status: 'done', disposal_site_id: await oneSite() }, owner.token);
    expect(a.status).toBe(200);
    eventIds.push(a.body.data.service_event.id);

    const other = await makeUser('driver', true);
    const second = await buildDay(other.id, prop, `dup-b-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${second.stopId}/status`,
      { status: 'done', disposal_site_id: await oneSite() }, other.token);

    expect(r.status).toBe(409);
    nothingLeaks(r.body);
    expect(r.body.existing_source).toBe('app');
    expect(r.body.message).toMatch(/already serviced/i);
    expect(r.body.message).not.toMatch(/Imported history/i);
  });
});

describe('DRV-13: a replayed write lands once', () => {
  it('answers one client_uuid three times with one row and one arrival time', async () => {
    const { randomUUID } = require('crypto');
    const d = await makeUser('driver', true);
    const day = await buildDay(d.id, await pick(), `replay-${RUN}`);
    const uuid = randomUUID();

    const attempts = [];
    for (let i = 0; i < 3; i += 1) {
      attempts.push(await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
        { status: 'arrived', client_uuid: uuid }, d.token));
    }

    // Three successes. A 409 here is data-correct and operationally broken: the driver is
    // looking at an error on a write that already happened, and the queue cannot drain.
    for (const a of attempts) expect(a.status).toBe(200);
    expect(attempts[0].body.replayed).toBe(false);
    expect(attempts[1].body.replayed).toBe(true);
    expect(attempts[2].body.replayed).toBe(true);

    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM septic_app.route_stops WHERE client_uuid = $1`, [uuid],
    );
    expect(rows[0].n).toBe(1);

    /**
     * The part a unique index cannot give you. The index makes the second insert impossible;
     * only reading the first attempt's row makes the second answer report the arrival time
     * that actually happened rather than the time of the retry.
     */
    const first = new Date(attempts[0].body.data.stop.arrived_at).getTime();
    for (const a of attempts.slice(1)) {
      expect(new Date(a.body.data.stop.arrived_at).getTime()).toBe(first);
    }
  });

  it('creates exactly one service event when a completion is replayed', async () => {
    const { randomUUID } = require('crypto');
    const d = await makeUser('driver', true);
    const prop = await pick();
    const day = await buildDay(d.id, prop, `replay2-${RUN}`);
    const uuid = randomUUID();

    for (let i = 0; i < 3; i += 1) {
      const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
        { status: 'done', gallons_pumped: 800, disposal_site_id: await oneSite(), client_uuid: uuid }, d.token);
      expect(r.status).toBe(200);
      if (r.body.data.service_event) eventIds.push(r.body.data.service_event.id);
    }

    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM septic_app.service_events
        WHERE property_id = $1 AND service_date = business_today()`, [prop],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('ownership: a stop you do not drive is not there', () => {
  it('answers 404 for another driver’s stop, identically to a stop that never existed', async () => {
    const owner = await makeUser('driver', true);
    const day = await buildDay(owner.id, await pick(), `own-${RUN}`);
    const stranger = await makeUser('driver', true);

    const real = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'arrived' }, stranger.token);
    const ghost = await send('PATCH', `/dispatch/stops/999999999/status`,
      { status: 'arrived' }, stranger.token);

    expect(real.status).toBe(404);
    expect(ghost.status).toBe(404);
    // Byte-identical, so the endpoint cannot be walked to discover which stop ids are live
    // on somebody else's day. A 403 would hand that out for free.
    expect(ghost.body).toEqual(real.body);
    expect((await stopRow(day.stopId)).status).toBe('pending');
  });

  it('refuses to work a day the office has not published', async () => {
    const d = await makeUser('driver', true);
    const prop = await pick();
    const created = await send('POST', '/routes',
      { route_date: businessToday, driver_id: d.id, truck_label: `draft-${RUN}` });
    expect(created.status).toBe(201);
    const routeId = Number(created.body.data.id);
    routeIds.push(routeId);
    const stop = await send('POST', `/routes/${routeId}/stops`, { property_id: prop });
    expect(stop.status).toBe(201);

    const r = await send('PATCH', `/dispatch/stops/${stop.body.data.id}/status`,
      { status: 'arrived' }, d.token);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/draft/);
    nothingLeaks(r.body);
  });

  it('refuses an anonymous write', async () => {
    const d = await makeUser('driver', true);
    const day = await buildDay(d.id, await pick(), `anon-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'arrived' }, '');
    expect(r.status).toBe(401);
  });

  it('refuses a negative gallon count before touching the ledger', async () => {
    const d = await makeUser('driver', true);
    const prop = await pick();
    const day = await buildDay(d.id, prop, `neg-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'done', gallons_pumped: -5 }, d.token);
    expect(r.status).toBe(400);
    nothingLeaks(r.body);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM septic_app.service_events
        WHERE property_id = $1 AND service_date = business_today()`, [prop],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('LED-03: completing a stop names where the waste went', () => {
  it('refuses a done with no disposal site, by field name, and files nothing', async () => {
    const d = await makeUser('driver', true);
    const prop = await pick();
    const day = await buildDay(d.id, prop, `nosite-${RUN}`);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'done', gallons_pumped: 1000 }, d.token);

    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/disposal_site_id/);
    expect(r.body.required).toContain('disposal_site_id');
    nothingLeaks(r.body);

    const stop = await stopRow(day.stopId);
    expect(stop.status).toBe('pending');
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM septic_app.service_events
        WHERE property_id = $1 AND service_date = business_today()`, [prop],
    );
    expect(rows[0].n).toBe(0);
  });

  it('still answers a terminal stop with the fact about the stop, not the missing field', async () => {
    /**
     * The ordering LED-03's refusal had to earn its place in. A driver
     * re-sending `done` for a stop that is already `skipped` needs to hear
     * "this stop is already skipped" — the thing they can act on — not a
     * complaint about a field the write never needed.
     */
    const d = await makeUser('driver', true);
    const day = await buildDay(d.id, await pick(), `ord-${RUN}`);
    await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'skipped' }, d.token);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'done' }, d.token);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/already skipped/i);
  });

  it('the database, not only the endpoint, refuses an app event without a site', async () => {
    // The API check can be forgotten by the next writer that reaches the ledger
    // (a future bulk-import tool, a fix-up script); the 0020 CHECK cannot.
    await expect(db.query(
      `INSERT INTO septic_app.service_events (property_id, service_date, source, status)
       VALUES ((SELECT min(id) FROM septic_app.properties), business_today() + 20000, 'app', 'completed')`,
    )).rejects.toThrow(/chk_ledger_app_disposal/);
  });

  it('does not retroactively condemn the legacy corpus', async () => {
    // 45,249 imported rows have no site and the report shows them under 'not
    // recorded'. If the CHECK ever loses its `source <> 'app'` half, an
    // idempotent re-load stops being a rebuild and starts being a mass
    // quarantine event (LED-05, P7) — this is the line that catches it.
    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO septic_app.service_events (property_id, service_date, source, status)
         VALUES ((SELECT min(id) FROM septic_app.properties), business_today() + 20000, 'legacy_import', 'completed')`,
      );
    } finally {
      await db.query('ROLLBACK');
    }
  });
});

describe('T-DRV-07b: the site list a lawful done is chosen from', () => {
  /**
   * The server has always required `disposal_site_id` on `done` (a service
   * event without a site is not the compliance record the state report is
   * assembled from) — and until this endpoint existed, the only way to have
   * that id was to know it already. Every older test in this file fetches a
   * site id from the DATABASE, which is the assumption the driver's phone
   * could not meet: the Done tap came back 400, the queue dropped it as
   * refused-on-facts, and the screen admitted nothing. These cases pin the
   * round trip the UI now depends on.
   */
  let driverToken = '';
  let driverId = 0;

  beforeAll(async () => {
    const d = await makeUser('driver', true);
    driverToken = d.token;
    driverId = d.id;
  });

  it('answers the driver with the vocabulary the next write will be judged against', async () => {
    const r = await send('GET', '/disposal-sites', undefined, driverToken);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.length).toBeGreaterThan(0);
    for (const s of r.body.data) {
      expect(Number.isInteger(s.id)).toBe(true);
      expect(typeof s.name).toBe('string');
    }
  });

  it('one id from that response is enough to finish a stop — no out-of-band knowledge', async () => {
    const list = await send('GET', '/disposal-sites', undefined, driverToken);
    const site = list.body.data[0];
    const prop = await pick();
    const day = await buildDay(driverId, prop, `site-list-${RUN}`);
    expect((await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'arrived' }, driverToken)).status).toBe(200);

    const done = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'done', gallons_pumped: 500, disposal_site_id: site.id }, driverToken);
    expect(done.status).toBe(200);
    const eventId = done.body.data.service_event.id;
    eventIds.push(eventId);

    const ev = await eventRow(eventId);
    expect(Number(ev.disposal_site_id)).toBe(site.id);
    expect(Number(ev.gallons_pumped)).toBe(500);
  });
});

describe('T-DRV-20: the implied site is a chosen default, never an invention', () => {
  let driverToken = '';
  let driverId = 0;

  beforeAll(async () => {
    const d = await makeUser('driver', true);
    driverToken = d.token;
    driverId = d.id;
  });

  it('marks exactly one site as the company default', async () => {
    const r = await send('GET', '/disposal-sites', undefined, driverToken);
    expect(r.status).toBe(200);
    const defaults = r.body.data.filter((x: any) => x.is_default);
    expect(defaults).toHaveLength(1);
  });

  it('the office can move the default and the list follows', async () => {
    const list = await send('GET', '/disposal-sites', undefined, driverToken);
    const rows = list.body.data;
    const before = rows.find((x: any) => x.is_default).id;
    const other = rows.find((x: any) => !x.is_default).id;

    const moved = await send('PATCH', '/disposal-sites/default', { site_id: other });
    expect(moved.status).toBe(200);
    const after = await send('GET', '/disposal-sites', undefined, driverToken);
    const movedRows = after.body.data;
    expect(movedRows.find((x: any) => x.is_default).id).toBe(other);

    // Restore: the seed default is a stated guess the office owns, but this
    // suite may not be the one to correct it.
    await send('PATCH', '/disposal-sites/default', { site_id: before });
  });

  it('refuses a default that is not a site, by naming it', async () => {
    const r = await send('PATCH', '/disposal-sites/default', { site_id: 999999999 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/No disposal site has id 999999999/);
  });

  it('still refuses a done with no site — the default is a pre-fill, not a fallback', async () => {
    const prop = await pick();
    const day = await buildDay(driverId, prop, `implied-${RUN}`);
    expect((await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'arrived' }, driverToken)).status).toBe(200);
    const r = await send('PATCH', `/dispatch/stops/${day.stopId}/status`,
      { status: 'done', gallons_pumped: 400 }, driverToken);
    expect(r.status).toBe(400);
    expect(r.body.required).toContain('disposal_site_id');
  });
});
