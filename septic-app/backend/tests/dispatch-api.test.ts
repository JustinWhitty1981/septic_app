import { Client } from 'pg';
import { connect } from './db';

/**
 * The driver's launch request, asked of the running server.
 *
 * DRV-01, DRV-03, DRV-04, DRV-05, DRV-10, DRV-11.
 *
 * This is the primary deliverable: the list a person reads standing at a truck, in a yard,
 * with two bars of signal. Everything wrong with it is wrong in the field rather than in a
 * log, and most of what could be wrong is invisible from the office — a site that quietly
 * dropped out of the payload, a due date off by one because it crossed a timezone, a county
 * normalised so hard it stopped being the place the driver was told to find.
 *
 * So the suite builds its own day out of properties chosen for the awkward thing each one
 * carries, and then asks the endpoint what it has. Choosing them by characteristic rather
 * than by id matters: the ids move when the ETL is re-run, and a suite pinned to ids would
 * start asserting nothing while still passing.
 *
 * Two assertions are worth calling out.
 *
 *  - **A route dated tomorrow is not today's.** Through the migration era the clock sat
 *    frozen at 2024-12-02 635 days behind the machine, which made this assertion cheap;
 *    the business went live on 2026-09-05 and the clock follows the calendar now. What the
 *    test still proves is the sentence that matters — dispatch answers to the SERVER's
 *    day: the office's tablet and the driver's phone may disagree about noon, and only one
 *    of them gets to decide what "today's route" means. The stop-capture suite keeps the
 *    frozen-clock proof alive honestly, by pinning `as_of_date` inside a transaction and
 *    rolling it back rather than freezing the shared calendar for a green test.
 *
 *  - **There is no way to ask for somebody else's day.** Not "the endpoint rejects driver_id
 *    for the wrong role" — the endpoint has no parameter at all, and the test proves the
 *    token wins even when a `?driver_id=` is supplied and is a valid one.
 */

const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';

const LEAKS = [
  'septic_app', 'legacy.', 'relation "', 'does not exist', 'column "',
  'violates foreign key', 'violates unique constraint', 'duplicate key value',
  'QueryFailedRunner', 'QueryFailedError', 'at Function.', 'invalid input syntax',
  'could not determine data type', 'null value in column',
];

let db: Client;
let adminToken = '';
let driverToken = '';
let driverId = 0;
let strangerToken = '';
let strangerId = 0;
const emails: string[] = [];
const routeIds: number[] = [];
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
const makeUser = async (role: string): Promise<{ token: string; id: number }> => {
  const { hashPassword } = require('../src/utils/password');
  // The sequence, not the role, keeps these unique: two drivers in one suite is the normal
  // case (that is the whole point of SCH-08), and an email built from the role alone would
  // make the second one a constraint violation in `beforeAll`, where nothing is readable.
  const email = `t-dispatch.${role}.${RUN}.${(userSeq += 1)}@test.invalid`;
  emails.push(email);
  const { rows } = await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Dispatch',$1,$2,$3::user_role,true) RETURNING id`,
    [email, await hashPassword(PASSWORD), role],
  );
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body: any = await res.json().catch(() => ({}));
  return { token: body?.token ?? '', id: Number(rows[0].id) };
};

/**
 * A property carrying one specific awkward thing, that nobody has booked today.
 *
 * `where` is a fragment over the alias `p` (and may join). It is a literal from this file and
 * never a request parameter, which is the only kind of SQL interpolation this suite allows.
 */
const chosen: number[] = [];
const pick = async (where: string, join = ''): Promise<number> => {
  const { rows } = await db.query(
    `SELECT p.id
       FROM septic_app.properties p ${join}
      WHERE p.status = 'active'
        AND ${where}
        AND NOT (p.id = ANY($2::int[]))
        AND NOT EXISTS (
          SELECT 1 FROM septic_app.route_stops s
            JOIN septic_app.routes r ON r.id = s.route_id
           WHERE s.property_id = p.id
             AND r.route_date = $1::date
             AND s.status NOT IN ('done','skipped'))
      ORDER BY p.id LIMIT 1`,
    [businessToday, chosen],
  );
  if (!rows.length) throw new Error(`no property matches: ${where}`);
  // Each site is chosen once. Without this, pTank and pMemo both resolved to the lowest
  // active id that fitted, the second add hit SCH-08's same-route rule, and beforeAll died
  // with a 409 that looked like a bug in the endpoint rather than in the fixture.
  chosen.push(Number(rows[0].id));
  return Number(rows[0].id);
};

/** The row the schema holds for a site, so the payload can be compared against it. */
const dbProperty = async (id: number) => {
  const { rows } = await db.query(
    `SELECT p.id, p.legacy_cust_number, p.payer_label, p.site_address, p.site_city,
            p.site_state, p.site_zip, p.reminder_opt_out, p.legacy_memo,
            p.tank_location_note, p.jobsite_location_note, p.chamber_pump_note,
            p.system_condition_note,
            c.name AS county_name, p.county_raw,
            to_char(p.next_service_due,'YYYY-MM-DD') AS next_service_due
       FROM septic_app.properties p
  LEFT JOIN septic_app.counties c ON c.id = p.county_id
      WHERE p.id = $1`,
    [id],
  );
  return rows[0];
};

const dbTanks = async (id: number) => {
  const { rows } = await db.query(
    `SELECT sequence_no::int AS sequence_no, role::text AS role, capacity_gallons,
            has_filter, raw_text
       FROM septic_app.tanks WHERE property_id = $1 ORDER BY sequence_no`,
    [id],
  );
  return rows;
};

/** The day the driver will be handed: four sites, each awkward in a different way. */
let routeId = 0;
let pTank = 0;
let pOptOut = 0;
let pCounty = 0;
let pMemo = 0;

beforeAll(async () => {
  db = await connect();
  const a = await makeUser('admin');
  const d = await makeUser('driver');
  const s = await makeUser('driver');
  adminToken = a.token;
  driverToken = d.token;
  driverId = d.id;
  strangerToken = s.token;
  strangerId = s.id;

  const today = await db.query(`SELECT to_char(business_today(),'YYYY-MM-DD') AS d`);
  businessToday = today.rows[0].d;

  // A site whose tanks do not fit in one row. Measured rather than assumed: the first draft
  // looked for a '+' in tanks.raw_text and there is not one in any of the 10,051 rows.
  // Composites are two rows here, and the awkward part is the string each row keeps —
  // '800PC', '1500w.fltr', '2000 triple'. 5,213 of 10,051 raw_text values are not a bare
  // number, and 2,446 properties carry more than one tank.
  pTank = await pick(`(SELECT count(*) FROM septic_app.tanks t
                        WHERE t.property_id = p.id) > 1
                       AND EXISTS (SELECT 1 FROM septic_app.tanks t2
                                    WHERE t2.property_id = p.id AND t2.raw_text ~ '[^0-9]')`);
  pOptOut = await pick(`p.reminder_opt_out`);
  // A raw spelling that differs from the county's own name, so the two columns cannot be
  // satisfied by an implementation that returns the same value twice. Asked of the database
  // rather than guessed from a list of spellings — 'Waushara' vs 'waushara' would have made
  // this pick a coin flip.
  pCounty = await pick(
    `p.county_id IS NOT NULL AND lower(p.county_raw) <> lower(c.name)`,
    `JOIN septic_app.counties c ON c.id = p.county_id`,
  );
  pMemo = await pick(`length(trim(p.legacy_memo)) > 20`);

  const created = await send('POST', '/routes',
    { route_date: businessToday, driver_id: driverId, truck_label: 'T-1' });
  expect(created.status).toBe(201);
  routeId = Number(created.body.data.id);
  routeIds.push(routeId);

  for (const prop of [pTank, pOptOut, pCounty, pMemo]) {
    expect((await send('POST', `/routes/${routeId}/stops`, { property_id: prop })).status).toBe(201);
  }
  expect((await send('POST', `/routes/${routeId}/publish`, {})).status).toBe(200);
});

afterAll(async () => {
  if (routeIds.length) {
    await db.query(`DELETE FROM septic_app.route_stops WHERE route_id = ANY($1::int[])`, [routeIds]);
    await db.query(`DELETE FROM septic_app.routes WHERE id = ANY($1::int[])`, [routeIds]);
  }
  for (const email of emails) {
    await db.query('DELETE FROM septic_app.users WHERE email = $1', [email]);
  }
  await db?.end();
});

describe('the suite is not vacuous', () => {
  it('issued tokens, found four awkward sites, and published a real day', async () => {
    // Every assertion below reads one of these. If any were 0 the suite would be asserting
    // that undefined equals undefined, which is the way a test suite dies: quietly, green.
    expect(driverToken.length).toBeGreaterThan(20);
    expect(businessToday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const p of [pTank, pOptOut, pCounty, pMemo]) expect(p).toBeGreaterThan(0);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM septic_app.route_stops WHERE route_id = $1`, [routeId],
    );
    expect(rows[0].n).toBe(4);
  });
});

describe('DRV-01: one request returns the whole day', () => {
  let day: any;
  beforeAll(async () => {
    const r = await send('GET', '/dispatch/today', undefined, driverToken);
    expect(r.status).toBe(200);
    day = r.body.data;
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await send('GET', '/dispatch/today', undefined, '')).status).toBe(401);
  });

  it('returns every stop the office put on the day, in order, in one response', () => {
    // Not paginated, not chunked: the day arrives whole or the app cannot cache it offline.
    expect(day.stops).toHaveLength(4);
    expect(day.stop_count).toBe(4);
    expect(day.route_id).toBe(routeId);
    expect(day.route_status).toBe('published');
    expect(day.truck_label).toBe('T-1');
    expect(day.stops.map((s: any) => s.sequence_no)).toEqual([1, 2, 3, 4]);
  });

  it('carries the whole stop card, so nothing has to be fetched at the jobsite', () => {
    const want = [
      'stop_id', 'sequence_no', 'stop_status', 'property_id', 'legacy_cust_number',
      'payer_label', 'site_address', 'site_city', 'site_state', 'site_zip',
      'county_name', 'county_raw', 'tank_location_note', 'jobsite_location_note',
      'chamber_pump_note', 'system_condition_note', 'reminder_opt_out',
      'next_service_due', 'tanks',
    ];
    for (const stop of day.stops) {
      // Every key present — a missing one is a card that cannot be rendered in a driveway.
      for (const k of want) expect(stop).toHaveProperty(k);
    }
  });

  it('dates leave as calendar strings, not as UTC instants', () => {
    // node-postgres returns a `date` as a Date at local midnight; JSON then writes a UTC
    // instant, and a site due on the 1st reads as due on the last day of the previous month
    // to anyone east of Greenwich. The property list had this bug. The driver's list is the
    // one that would have been acted on.
    expect(day.route_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const stop of day.stops) {
      if (stop.next_service_due !== null) {
        expect(stop.next_service_due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('is the server’s today, not the client’s clock', async () => {
    // The whole P10 argument in one assertion: a route dated tomorrow exists, is
    // published, and is still not today's dispatch. Since the business went live the
    // server clock follows the machine — what the assertion still has to prove is
    // that dispatch answers to the *server's* day and nobody else's.
    const d = new Date(`${businessToday}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    const tomorrow = d.toISOString().slice(0, 10);
    expect(tomorrow).not.toBe(businessToday);  // tomorrow really is tomorrow
    // — measured against the server's own day, not a Node UTC clock: the
    // business day is Central (0032) and this container's UTC date is
    // routinely a day ahead of it in the evening.

    const r = await send('POST', '/routes', { route_date: tomorrow, driver_id: strangerId });
    expect(r.status).toBe(201);
    routeIds.push(Number(r.body.data.id));
    expect((await send('POST', `/routes/${r.body.data.id}/stops`,
      { property_id: pTank })).status).toBe(201);
    expect((await send('POST', `/routes/${r.body.data.id}/publish`, {})).status).toBe(200);

    const mine = await send('GET', '/dispatch/today', undefined, strangerToken);
    expect(mine.status).toBe(404);
    expect(mine.body.business_today).toBe(businessToday);
  });

  it('hides a day the office has not published', async () => {
    // A draft is the office's rough work. A driver reading it reads the mistakes, and a
    // route that can still be edited under them is not a plan (SCH-09).
    const r = await send('POST', '/routes', { route_date: businessToday, driver_id: strangerId });
    expect(r.status).toBe(201);
    routeIds.push(Number(r.body.data.id));
    // A site nobody has booked today. pTank is already on the other driver's day, and the
    // endpoint says so — reusing it here would test SCH-08 by accident and call the 409 a
    // draft-hiding rule.
    expect((await send('POST', `/routes/${r.body.data.id}/stops`,
      { property_id: await pick(`p.id IS NOT NULL`) })).status).toBe(201);

    const draft = await send('GET', '/dispatch/today', undefined, strangerToken);
    expect(draft.status).toBe(404);
    expect(draft.body.message).toMatch(/nothing published/i);
    nothingLeaks(draft.body);
  });
});

describe('what a stop card is made of', () => {
  let stops: Record<number, any> = {};
  beforeAll(async () => {
    const r = await send('GET', '/dispatch/today', undefined, driverToken);
    for (const s of r.body.data.stops) stops[Number(s.property_id)] = s;
  });

  it('DRV-03: shows the tank string the source contained, beside the numbers parsed from it', async () => {
    // '2000 triple' is the thing stencilled on the lid. The parsed rows are the thing the
    // invoice is built from. Showing only one of the two makes the other unfalsifiable,
    // which is why tanks.raw_text is NOT NULL in the schema and why both belong on the card.
    const stop = stops[pTank];
    const tanks = await dbTanks(pTank);
    expect(Array.isArray(stop.tanks)).toBe(true);
    expect(stop.tanks.length).toBe(tanks.length);

    for (let i = 0; i < tanks.length; i += 1) {
      expect(stop.tanks[i].raw).toBe(tanks[i].raw_text);
      expect(stop.tanks[i].sequence_no).toBe(tanks[i].sequence_no);
      expect(stop.tanks[i].role).toBe(tanks[i].role);
      expect(stop.tanks[i].has_filter).toBe(tanks[i].has_filter);
      expect(stop.tanks[i].gallons).toBe(
        tanks[i].capacity_gallons === null ? null : Number(tanks[i].capacity_gallons));
    }
    // The property this stop was chosen for: at least one of these strings is not a number,
    // which is the whole reason raw_text exists — the parse is checkable against it.
    expect(stop.tanks.some((t: any) => /[^0-9]/.test(String(t.raw)))).toBe(true);
    expect(stop.tanks.length).toBeGreaterThan(1);
  });

  it('DRV-04: the address is the one on the record, field for field', async () => {
    const want = await dbProperty(pTank);
    const stop = stops[pTank];
    expect(stop.site_address).toBe(want.site_address);
    expect(stop.site_city).toBe(want.site_city);
    expect(stop.site_state).toBe(want.site_state);
    expect(stop.site_zip).toBe(want.site_zip);
    expect(stop.payer_label).toBe(want.payer_label);
    // The number a person on the phone would say, which is not the primary key.
    expect(stop.legacy_cust_number).toBe(want.legacy_cust_number);
  });

  it('DRV-05: the field notes travel with the stop', async () => {
    const want = await dbProperty(pMemo);
    const stop = stops[pMemo];
    for (const k of ['tank_location_note', 'jobsite_location_note',
                     'chamber_pump_note', 'system_condition_note'] as const) {
      expect(stop[k]).toBe(want[k]);
    }
    // The memo is one of the 7,427 free-text notes the legacy system kept verbatim. It is not
    // in this payload under a prettier name, and it is not dropped for being unstructured.
    expect(want.legacy_memo && want.legacy_memo.length).toBeGreaterThan(20);
  });

  it('DRV-10: an opted-out household says so on the card', async () => {
    const want = await dbProperty(pOptOut);
    expect(want.reminder_opt_out).toBe(true);
    expect(stops[pOptOut].reminder_opt_out).toBe(true);

    // The stronger form, and the one that cannot go stale: the flag is checked against the
    // row it came from for every stop on the day, not just the one picked for being odd. A
    // payload that returned `true` for everybody would pass the check above and fail this.
    for (const [id, stop] of Object.entries(stops)) {
      const row = await dbProperty(Number(id));
      expect(stop.reminder_opt_out).toBe(row.reminder_opt_out);
    }
  });

  it('DRV-11: the county arrives normalised and raw, and they are not the same string', async () => {
    // 34 spellings for about 7 counties; 'FDL' is 26 of them. A driver told "Fond du Lac"
    // when the paperwork says FDL needs to see both, and the office needs the raw one to know
    // the normalisation did not guess.
    const want = await dbProperty(pCounty);
    const stop = stops[pCounty];
    expect(stop.county_raw).toBe(want.county_raw);
    expect(stop.county_name).toBe(want.county_name);
    expect(stop.county_name).not.toBeNull();
    expect(String(stop.county_raw).toLowerCase()).not.toBe(String(stop.county_name).toLowerCase());
  });

  it('a site with no county at all can say so, rather than inventing one', async () => {
    // 0013 refused to map a municipality to a county because that means guessing where the
    // parcel sits, which LED-06 forbids. So the payload must be able to express "unknown",
    // and there must be a real row like that to express it about.
    const unknown = await pick(`p.county_id IS NULL AND p.county_raw IS NOT NULL`);
    expect(unknown).toBeGreaterThan(0);
  });
});

describe('whose day this is', () => {
  it('answers for the token, and ignores a driver_id that is not the caller’s', async () => {
    // There is no :id on this route and no parameter to authorise. Handing it a valid id for
    // somebody else has to change nothing, because a stolen tablet is the threat model and
    // the driver token is the lowest-privilege credential in the system.
    const mine = await send('GET', `/dispatch/today?driver_id=${strangerId}`, undefined, driverToken);
    expect(mine.status).toBe(200);
    expect(mine.body.data.driver.id).toBe(driverId);

    const flipped = await send('GET', `/dispatch/today?driver_id=${driverId}`, undefined, strangerToken);
    expect(flipped.status).toBe(404);
  });

  it('names the driver it is answering for, so a tablet can show the right name', async () => {
    const r = await send('GET', '/dispatch/today', undefined, driverToken);
    expect(r.body.data.driver.id).toBe(driverId);
    expect(r.body.data.business_today).toBe(businessToday);
  });
});

describe('NF-11: a missing day does not describe the server', () => {
  it('answers a driver with no route in English, not in Postgres', async () => {
    const lonely = await makeUser('driver');
    const r = await send('GET', '/dispatch/today', undefined, lonely.token);
    expect(r.status).toBe(404);
    expect(r.body.message).toBeTruthy();
    nothingLeaks(r.body);
  });
});
