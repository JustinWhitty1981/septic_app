import { Client } from 'pg';
import { connect } from './db';

/**
 * T-SCH-15 / T-SCH-16 — the due queue learns to keep two secrets honestly.
 *
 *  - a site booked on a future day (draft included) is not work left to
 *    plan, so the default queue stops showing it — but `show_scheduled=1`
 *    reads it back with the day and the driver, because hiding a row and
 *    silently deleting a pump-out must never be the same act; and
 *  - the office can dispute a generated due date with a dated, attributed,
 *    *reasoned* overlay row — while `next_service_due` stays the generated
 *    column SCH-11 says it is. The overlay moves the queue's answer, not the
 *    column, and closing it in one action restores the computed truth.
 *
 * Fixtures are brand-new sites planted in the smallest county: a fresh id is
 * the largest in the table, so no parallel suite's `ORDER BY p.id LIMIT 1`
 * will ever pick one up mid-run, and the county filter keeps every queue
 * scan to a page or two instead of a fifteen-page trudge through the
 * corpus. Each site's `last_service_date` is planted past enough to sit in
 * the overdue set, and the whole site is deleted in `afterAll` — stops and
 * routes go first (their rows reference it), adjustments go wherever.
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
let businessToday = '';
// The county these sites are planted in. Asked of the database, not hardcoded:
// the migration machine's Fond du Lac happens to have id 15, and a fresh
// install numbers its counties from 1 — an id pinned here would be a fact
// about one machine, not about the requirement.
let countyId = 0;
let officeToken = '';
let driverId = 0;
const emails: string[] = [];
const routeIds: number[] = [];
const stopIds: number[] = [];
const propertyIds: number[] = [];

interface Res { status: number; body: any }

const send = async (method: string, path: string, body?: unknown, token?: string): Promise<Res> => {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const t = token ?? officeToken;
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

const shiftDay = (base: string, days: number): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) {
    throw new Error('shiftDay needs business_today(); called before beforeAll filled it');
  }
  const d = new Date(`${base}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * The queue as an API client, for one property: pages until the row shows up
 * or the pages run out. The county filter makes this cheap — six neighbours,
 * not seven thousand — and the answer is the same thing the office sees:
 * present, absent, and with which words.
 */
const findQueueRow = async (query: string, propertyId: number): Promise<any | null> => {
  for (let page = 1; page <= 8; page += 1) {
    const r = await send('GET',
      `/properties/due-queue?${query}&county_id=${countyId}&page=${page}&limit=500`);
    expect(r.status).toBe(200);
    const hit = (r.body.data as any[]).find((x) => x.property_id === propertyId);
    if (hit) return hit;
    if (page * 500 >= Number(r.body.meta.total)) return null;
  }
  return null;
};

/** A new active site, planted overdue in `countyId`, ready to be booked or disputed. */
const newSite = async (): Promise<number> => {
  const r = await send('POST', '/properties', {
    site_address: `1 ${RUN} Due Test Lane`,
    site_city: 'Testford', site_state: 'wi', site_zip: '54932',
    payer_label: `T-SCH-15 ${RUN}`, county_id: countyId, service_interval_days: 1095,
  });
  expect(r.status).toBe(201);
  const id = Number(r.body.data.id);
  propertyIds.push(id);
  // last_service_date is server-owned by design (SCH-11 refuses it at the API —
  // which is why the fixture writes it through the database, the same door ETL
  // used, and restores the row by deleting it).
  await db.query(
    `UPDATE septic_app.properties SET last_service_date = $2::date WHERE id = $1`,
    [id, shiftDay(businessToday, -1096)],   // due yesterday: overdue by one
  );
  return id;
};

beforeAll(async () => {
  db = await connect();
  businessToday = (await db.query(
    `SELECT to_char(business_today(),'YYYY-MM-DD') AS d`)).rows[0].d;
  countyId = Number((await db.query(
    `SELECT min(id) AS id FROM septic_app.counties`)).rows[0].id);

  const { hashPassword } = require('../src/utils/password');
  const mk = async (role: string) => {
    const email = `t-sch1516.${role}.${RUN}@test.invalid`;
    emails.push(email);
    const { rows } = await db.query(
      `INSERT INTO septic_app.users
         (first_name, last_name, email, password_hash, role, is_active)
       VALUES ('T','Sch1516',$1,$2,$3::user_role,true) RETURNING id`,
      [email, await hashPassword(PASSWORD), role],
    );
    const login = await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    return { id: Number(rows[0].id), token: ((await login.json() as any).token ?? '') };
  };
  officeToken = (await mk('office')).token;
  driverId = (await mk('driver')).id;
}, 60_000);

afterAll(async () => {
  if (propertyIds.length) {
    await db.query(
      `DELETE FROM septic_app.due_date_adjustments WHERE property_id = ANY($1::int[])`,
      [propertyIds]);
  }
  if (stopIds.length) {
    await db.query(`DELETE FROM septic_app.route_stops WHERE id = ANY($1::int[])`, [stopIds]);
  }
  if (routeIds.length) {
    await db.query(`DELETE FROM septic_app.routes WHERE id = ANY($1::int[])`, [routeIds]);
    await db.query(`DELETE FROM septic_app.route_stops WHERE route_id = ANY($1::int[])`, [routeIds]);
  }
  if (propertyIds.length) {
    await db.query(`DELETE FROM septic_app.properties WHERE id = ANY($1::int[])`, [propertyIds]);
  }
  for (const email of emails) {
    await db.query('DELETE FROM septic_app.users WHERE email = $1', [email]);
  }
  await db?.end();
});

describe('T-SCH-15: a booked site is not a due site', () => {
  jest.setTimeout(60_000);

  // One site, one day, three states of the same story — written as a sequence
  // because that IS the thing the office does: draft it, publish it, or watch
  // the driver skip it and see the site back where it belongs.
  let site = 0;
  let routeId = 0;
  let stopId = 0;
  let day = '';
  beforeAll(() => { day = shiftDay(businessToday, 5); });

  it('a draft day hides it from the default queue and the revealed queue calls it booked, not due',
    async () => {
      site = await newSite();
      // Before the booking, the queue says what it has always said.
      expect(await findQueueRow('filter=all', site)).toBeTruthy();

      const made = await send('POST', '/routes', { route_date: day, driver_id: driverId });
      expect(made.status).toBe(201);
      routeId = Number(made.body.data.id);
      routeIds.push(routeId);
      const stop = await send('POST', `/routes/${routeId}/stops`, { property_id: site });
      expect(stop.status).toBe(201);
      stopId = Number(stop.body.data.id);
      stopIds.push(stopId);

      // Gone from the default queue — but gone as a booking, not as a deletion.
      expect(await findQueueRow('filter=all', site)).toBeNull();

      const row = await findQueueRow('filter=all&show_scheduled=1', site);
      expect(row).toBeTruthy();
      expect(row.scheduled_on).toBe(day);
      // The draft counts, and says so: the office's model of a saved draft is
      // "it is on Tuesday", and the queue owes them the true word about it.
      expect(row.scheduled_status).toBe('draft');
      expect(row.scheduled_driver).toMatch(/T, Sch1516|Sch1516/);
    });

  it('publishing changes the words, not the hiding', async () => {
    expect((await send('POST', `/routes/${routeId}/publish`, {})).status).toBe(200);
    expect(await findQueueRow('filter=all', site)).toBeNull();
    const row = await findQueueRow('filter=all&show_scheduled=1', site);
    expect(row).toBeTruthy();
    expect(row.scheduled_status).toBe('published');
  });

  it('a skipped stop is a pump-out that did not happen: the site is due again',
    async () => {
      // Terminal verdict without a service. Written the way the driver's tap
      // would leave it — the view reads the row, not the wish behind it.
      await db.query(
        `UPDATE septic_app.route_stops SET status = 'skipped',
                resolved_at = now() WHERE id = $1`, [stopId]);

      const row = await findQueueRow('filter=all', site);
      expect(row).toBeTruthy();       // back where the queue asks again
      expect(row.scheduled_on).toBeNull();
      expect(row.days_overdue).toBeGreaterThan(0);
    });

  it('yesterday is history, not a booking', async () => {
    const late = await newSite();
    const yesterday = shiftDay(businessToday, -1);
    const made = await send('POST', '/routes', { route_date: yesterday, driver_id: driverId });
    expect(made.status).toBe(201);
    const rid = Number(made.body.data.id);
    routeIds.push(rid);
    const stop = await send('POST', `/routes/${rid}/stops`, { property_id: late });
    expect(stop.status).toBe(201);
    stopIds.push(Number(stop.body.data.id));
    expect((await send('POST', `/routes/${rid}/publish`, {})).status).toBe(200);

    // An open stop on a day already gone cannot stand in for a due date —
    // otherwise every unpublished-in-time day would silently retire its sites
    // from the queue, and the whole ETL corpus is one long lesson in what
    // "we did not get to it" quietly becomes.
    const row = await findQueueRow('filter=all', late);
    expect(row).toBeTruthy();
    expect(row.scheduled_on).toBeNull();
  });
});

describe('T-SCH-16: a due date the office can argue with', () => {
  jest.setTimeout(60_000);

  let futureDay = '';
  const reason = 'Competitor pumped the tank last month';
  beforeAll(() => { futureDay = shiftDay(businessToday, 900); });

  it('an adjustment moves the queue answer, never the generated column', async () => {
    const site = await newSite();
    const before = (await db.query(
      `SELECT to_char(next_service_due,'YYYY-MM-DD') AS due,
              to_char(last_service_date,'YYYY-MM-DD') AS last
         FROM septic_app.properties WHERE id = $1`, [site])).rows[0];
    expect(before.due).toBe(shiftDay(businessToday, -1));   // due yesterday

    const r = await send('POST', `/properties/${site}/due-adjustments`,
      { adjusted_due_date: futureDay, reason });
    expect(r.status).toBe(201);
    expect(r.body.data.created_by).toBeGreaterThan(0);
    expect(r.body.data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    nothingLeaks(r.body);

    const row = await findQueueRow('filter=all', site);
    expect(row).toBeTruthy();
    expect(row.adjusted).toBe(true);
    expect(row.effective_due_date).toBe(futureDay);
    expect(row.next_service_due).toBe(before.due);           // the column did not move
    expect(row.adjustment_reason).toBe(reason);
    expect(row.days_overdue).toBeLessThanOrEqual(0);         // and the nag stopped

    const after = (await db.query(
      `SELECT to_char(next_service_due,'YYYY-MM-DD') AS due,
              to_char(last_service_date,'YYYY-MM-DD') AS last
         FROM septic_app.properties WHERE id = $1`, [site])).rows[0];
    expect(after).toEqual(before);   // SCH-11, stated as a diff: nothing moved
  });

  it('every refusal names what is wrong and what to do instead', async () => {
    const site = await newSite();

    const bad = await send('POST', `/properties/${site}/due-adjustments`,
      { adjusted_due_date: 'tomorrow-ish', reason });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('YYYY-MM-DD');
    nothingLeaks(bad.body);

    const mute = await send('POST', `/properties/${site}/due-adjustments`,
      { adjusted_due_date: futureDay, reason: '   ' });
    expect(mute.status).toBe(400);
    expect(mute.body.message).toContain('reason');
    nothingLeaks(mute.body);

    // The past is a ledger claim, and the ledger answers claims with events.
    const past = await send('POST', `/properties/${site}/due-adjustments`,
      { adjusted_due_date: '2000-01-01', reason });
    expect(past.status).toBe(400);
    expect(past.body.message).toContain(businessToday);
    expect(past.body.message).toContain('correction');
    nothingLeaks(past.body);

    // Nothing landed on any of them.
    expect((await db.query(
      `SELECT count(*)::int AS n FROM septic_app.due_date_adjustments WHERE property_id = $1`,
      [site])).rows[0].n).toBe(0);
  });

  it('a second open adjustment is refused by naming the first', async () => {
    const site = await newSite();
    expect((await send('POST', `/properties/${site}/due-adjustments`,
      { adjusted_due_date: futureDay, reason })).status).toBe(201);

    const twice = await send('POST', `/properties/${site}/due-adjustments`,
      { adjusted_due_date: shiftDay(businessToday, 1200), reason: 'Also, the tank was replaced' });
    expect(twice.status).toBe(409);
    expect(twice.body.message).toContain(futureDay);
    expect(twice.body.message).toContain(reason);
    nothingLeaks(twice.body);
  });

  it('closing retires the overlay, the generated date stands, and closed does not mean blocked',
    async () => {
      const site = await newSite();
      const raw = (await db.query(
        `SELECT to_char(next_service_due,'YYYY-MM-DD') AS due
           FROM septic_app.properties WHERE id = $1`, [site])).rows[0].due;
      expect((await send('POST', `/properties/${site}/due-adjustments`,
        { adjusted_due_date: futureDay, reason })).status).toBe(201);

      const closed = await send('DELETE', `/properties/${site}/due-adjustments`);
      expect(closed.status).toBe(200);
      expect(closed.body.data.closed).toBe(true);

      const row = await findQueueRow('filter=all', site);
      expect(row).toBeTruthy();
      expect(row.adjusted).toBe(false);
      expect(row.effective_due_date).toBe(raw);              // the plain schedule again
      expect(row.days_overdue).toBeGreaterThan(0);

      // Nothing to close.
      expect((await send('DELETE', `/properties/${site}/due-adjustments`)).status).toBe(404);

      // And the closed row did not stay in the way: the unique index is PARTIAL,
      // history is allowed, and a site is never wedged by its own paperwork.
      expect((await send('POST', `/properties/${site}/due-adjustments`,
        { adjusted_due_date: shiftDay(businessToday, 1200),
          reason: 'Second opinion a year later' })).status).toBe(201);
    });

  it('a site that does not exist is 404 in both directions, in the same sentence',
    async () => {
      const gone = await send('POST', '/properties/999999999/due-adjustments',
        { adjusted_due_date: futureDay, reason });
      expect(gone.status).toBe(404);
      expect(gone.body.message).toContain('No site has id 999999999');

      const closed = await send('DELETE', '/properties/999999999/due-adjustments');
      expect(closed.status).toBe(404);
      expect(closed.body.message).toContain('No site has id 999999999');
    });
});
