import { Client } from 'pg';
import { connect } from './db';

/**
 * T-SCH-13 — adding an open site to a driver's day.
 *
 * `POST /api/routes/stops` names its route by (driver, date) instead of by id, and the
 * single interesting property is that find-or-create-day and the SCH-08 clash check run
 * in ONE transaction. The clash is the common failure of this feature — a clerk offers a
 * site that Tuesday already belongs to somebody else — and if the day were created first
 * and the append refused afterwards, every refused booking would leave an empty draft for
 * a driver who never asked for one. The atomicity case below is therefore not paranoia:
 * it counts driver B's routes before and after a refused booking.
 *
 * Same house rules as route-composition.test.ts: properties are chosen at the moment of
 * use from the set unrouted on the business date, every route gets its own day, the
 * database is the evidence, and `afterAll` deletes what it planted.
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
let officeToken = '';
let driverAId = 0;
let driverBId = 0;
let adminId = 0;
let deadDriverId = 0;
const emails: string[] = [];
const routeIds: number[] = [];

let businessToday = '';

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

let userSeq = 0;
const makeUser = async (role: string, active = true): Promise<number> => {
  const { hashPassword } = require('../src/utils/password');
  const email = `t-sch13.${role}.${RUN}.${(userSeq += 1)}@test.invalid`;
  emails.push(email);
  const { rows } = await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Sch13',$1,$2,$3::user_role,$4) RETURNING id`,
    [email, await hashPassword(PASSWORD), role, active],
  );
  return Number(rows[0].id);
};

const login = async (email: string): Promise<string> => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body: any = await res.json().catch(() => ({}));
  return body?.token ?? '';
};

const freeProperty = async (offset = 0): Promise<number> => {
  const { rows } = await db.query(
    `SELECT p.id
       FROM septic_app.properties p
      WHERE p.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM septic_app.route_stops s
            JOIN septic_app.routes r ON r.id = s.route_id
           WHERE s.property_id = p.id
             AND r.route_date = $1::date
             AND s.status NOT IN ('done','skipped'))
      ORDER BY p.id
      LIMIT 1 OFFSET $2`,
    [businessToday, offset],
  );
  if (!rows.length) throw new Error('no unrouted active property available for the test date');
  return Number(rows[0].id);
};

/**
 * A date nobody has used yet — SCH-04 pins (route_date, driver_id) unique, so sharing
 * one day across tests would make the first success the rest of the suite's blocker.
 */
let dayOffset = 1;
const uniqueDate = (base = businessToday): string => {
  const d = new Date(`${base}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  dayOffset += 1;
  return d.toISOString().slice(0, 10);
};

const routesFor = async (driverId: number, date: string): Promise<number[]> => {
  const { rows } = await db.query(
    `SELECT id FROM septic_app.routes WHERE driver_id = $1 AND route_date = $2::date`,
    [driverId, date],
  );
  return rows.map((r) => Number(r.id));
};

const stopsFor = async (routeId: number) => {
  const { rows } = await db.query(
    `SELECT id, sequence_no::int AS seq, property_id, status::text AS status
       FROM septic_app.route_stops WHERE route_id = $1 ORDER BY sequence_no`,
    [routeId],
  );
  return rows;
};

beforeAll(async () => {
  db = await connect();
  const { rows } = await db.query(
    `SELECT to_char(business_today(),'YYYY-MM-DD') AS t`,
  );
  businessToday = rows[0].t;
  const officeEmail = `t-sch13.office.${RUN}@test.invalid`;
  emails.push(officeEmail);
  const { hashPassword } = require('../src/utils/password');
  await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Office',$1,$2,'office',true)`,
    [officeEmail, await hashPassword(PASSWORD)],
  );
  officeToken = await login(officeEmail);
  expect(officeToken).toBeTruthy();
  driverAId = await makeUser('driver');
  driverBId = await makeUser('driver');
  adminId = await makeUser('admin');
  deadDriverId = await makeUser('driver', false);
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

describe('T-SCH-13: a site record can open its driver\'s day', () => {
  it('books the first stop of a day that does not exist, and says it made the day', async () => {
    const date = uniqueDate();
    const propertyId = await freeProperty(0);
    const { status, body } = await send('POST', '/routes/stops',
      { property_id: propertyId, driver_id: driverAId, route_date: date });
    expect(status).toBe(201);
    expect(body.data).toMatchObject({
      sequence_no: 1, status: 'pending', route_date: date,
      driver_id: driverAId, route_created: true,
    });
    routeIds.push(Number(body.data.route_id));
    expect(Number(body.data.route_id)).toBeGreaterThan(0);

    const { rows: routeRows } = await db.query(
      `SELECT status::text AS status FROM septic_app.routes WHERE id = $1`,
      [body.data.route_id],
    );
    expect(routeRows[0].status).toBe('draft');
    const stops = await stopsFor(Number(body.data.route_id));
    expect(stops).toHaveLength(1);
    expect(Number(stops[0].property_id)).toBe(propertyId);
  });

  it('the second site lands on the same day, sequence 2, route_created false', async () => {
    // The (route_date, driver_id) rule of POST /routes is not a wall here — it is the
    // point. If this endpoint 409'd on an existing day it would be a worse composer.
    const date = uniqueDate();
    const first = await send('POST', '/routes/stops',
      { property_id: await freeProperty(1), driver_id: driverAId, route_date: date });
    expect(first.status).toBe(201);
    const routeId = Number(first.body.data.route_id);
    routeIds.push(routeId);

    const second = await send('POST', '/routes/stops',
      { property_id: await freeProperty(2), driver_id: driverAId, route_date: date });
    expect(second.status).toBe(201);
    expect(second.body.data).toMatchObject({
      route_id: routeId, sequence_no: 2, route_created: false,
    });
    expect(await stopsFor(routeId)).toHaveLength(2);
  });

  it('a clash is refused naming the route that has the site — and leaves NO empty draft for the refused driver', async () => {
    // The transaction case. Driver A owns the site that day; the same site is offered
    // to B. Before one transaction existed, B's day would have been created first and
    // the refusal would have arrived after the write.
    const date = uniqueDate();
    const propertyId = await freeProperty(3);
    const a = await send('POST', '/routes/stops',
      { property_id: propertyId, driver_id: driverAId, route_date: date });
    expect(a.status).toBe(201);
    const aRoute = Number(a.body.data.route_id);
    routeIds.push(aRoute);

    const beforeCount = (await routesFor(driverBId, date)).length;
    const b = await send('POST', '/routes/stops',
      { property_id: propertyId, driver_id: driverBId, route_date: date });
    expect(b.status).toBe(409);
    expect(b.body.message).toMatch(/Already routed on \d{4}-\d{2}-\d{2} to T Sch13 \(route \d+\)\. Remove it there first\./);
    expect(Number(b.body.already_on_route_id)).toBe(aRoute);
    nothingLeaks(b.body);
    expect((await routesFor(driverBId, date)).length).toBe(beforeCount);
    expect((await routesFor(driverBId, date)).length).toBe(0);
  });

  it('a site already on this very day says so, without pretending it is somebody else\'s', async () => {
    const date = uniqueDate();
    const propertyId = await freeProperty(4);
    const first = await send('POST', '/routes/stops',
      { property_id: propertyId, driver_id: driverAId, route_date: date });
    routeIds.push(Number(first.body.data.route_id));
    const again = await send('POST', '/routes/stops',
      { property_id: propertyId, driver_id: driverAId, route_date: date });
    expect(again.status).toBe(409);
    expect(again.body.message).toBe('This site is already on this route.');
  });

  it('a published day refuses to be edited, naming driver, date and the remedy', async () => {
    const date = uniqueDate();
    const route = await send('POST', '/routes', { route_date: date, driver_id: driverAId });
    expect(route.status).toBe(201);
    const routeId = Number(route.body.data.id);
    routeIds.push(routeId);
    await send('POST', `/routes/${routeId}/stops`, { property_id: await freeProperty(5) });
    expect((await send('POST', `/routes/${routeId}/publish`, {})).status).toBe(200);

    const late = await send('POST', '/routes/stops',
      { property_id: await freeProperty(6), driver_id: driverAId, route_date: date });
    expect(late.status).toBe(409);
    expect(late.body.message).toContain('published');
    expect(late.body.message).toMatch(/Unpublish it before adding stops\./);
    expect(await stopsFor(routeId)).toHaveLength(1);
  });

  it('this endpoint and /:id/stops see each other — one site, one day, whoever books it first', async () => {
    // The advisory-lock key format is load-bearing: two endpoints double-booking each
    // other while each is internally correct is the exact shape this cannot be allowed
    // to take.
    const date = uniqueDate();
    const propertyId = await freeProperty(7);
    const here = await send('POST', '/routes/stops',
      { property_id: propertyId, driver_id: driverAId, route_date: date });
    routeIds.push(Number(here.body.data.route_id));

    const bRoute = await send('POST', '/routes', { route_date: date, driver_id: driverBId });
    expect(bRoute.status).toBe(201);
    const bRouteId = Number(bRoute.body.data.id);
    routeIds.push(bRouteId);

    const there = await send('POST', `/routes/${bRouteId}/stops`, { property_id: propertyId });
    expect(there.status).toBe(409);
    expect(there.body.message).toMatch(/Already routed/);
  });

  it('the guardrails are the create endpoint\'s sentences, not new ones', async () => {
    const date = uniqueDate();
    const propertyId = await freeProperty(8);
    const base = { property_id: propertyId, driver_id: driverAId, route_date: date };

    expect((await send('POST', '/routes/stops', { ...base, route_date: undefined })).status).toBe(400);
    expect((await send('POST', '/routes/stops', { ...base, route_date: 'someday' })).status).toBe(400);
    expect((await send('POST', '/routes/stops', { ...base, driver_id: undefined })).status).toBe(400);
    expect((await send('POST', '/routes/stops', { ...base, property_id: undefined })).status).toBe(400);

    const ghost = await send('POST', '/routes/stops', { ...base, driver_id: 999999 });
    expect(ghost.status).toBe(404);
    expect(ghost.body.message).toBe('Driver not found');
    nothingLeaks(ghost.body);

    const accountant = await send('POST', '/routes/stops', { ...base, driver_id: adminId });
    expect(accountant.status).toBe(409);
    expect(accountant.body.message).toMatch(/is admin, not a driver/);

    const dead = await send('POST', '/routes/stops', { ...base, driver_id: deadDriverId });
    expect(dead.status).toBe(409);
    expect(dead.body.message).toMatch(/disabled and cannot be routed/);
  });

  it('an unknown property 404s and the day it would have opened is not opened', async () => {
    const date = uniqueDate();
    const res = await send('POST', '/routes/stops',
      { property_id: 999999, driver_id: driverAId, route_date: date });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Property not found');
    nothingLeaks(res.body);
    expect(await routesFor(driverAId, date)).toHaveLength(0);
  });
});
