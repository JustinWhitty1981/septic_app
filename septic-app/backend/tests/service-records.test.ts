import { Client } from 'pg';
import { connect } from './db';

/**
 * T-DRV-21 — a service record with no route behind it (`POST /api/ledger/events`).
 *
 * The truck finds work the office never routed: a competitor's customer calls
 * the driver, an overflow day runs into tomorrow. This endpoint is the capture
 * endpoint's discipline at a second door, and these tests are mostly proof
 * that the discipline survived the move — the server's day, the login's pumper,
 * the mandatory disposal site, warned-not-quiet gallons, and a `client_uuid`
 * that makes the flaky phone file the pump-out once.
 *
 * Each filing needs its own property: one event per site per day is the whole
 * point of the already-serviced guard, so two files against one site on one
 * day is a collision the test would trip by accident. Fixtures are planted as
 * brand-new sites (largest ids in the table — no parallel suite's
 * `ORDER BY id LIMIT 1` will grab one), and the ledger-guarded teardown uses
 * the `septic.ledger_repair` escape exactly as the other suites do: one
 * transaction, child rows before the property goes.
 */

const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';
const uuid = () => require('crypto').randomUUID();

const LEAKS = [
  'septic_app', 'legacy.', 'relation "', 'does not exist', 'column "',
  'violates foreign key', 'violates unique constraint', 'duplicate key value',
  'QueryFailedRunner', 'QueryFailedError', 'at Function.', 'invalid input syntax',
  'could not determine data type', 'null value in column',
];

let db: Client;
let businessToday = '';
let officeToken = '';
let driverToken = '';       // has a pumper link
let anonDriverToken = '';   // no pumper link
let siteId = 0;
let wasteTypeId = 0;
let disposalSiteId = 0;

const emails: string[] = [];
const eventIds: string[] = [];
const pumperIds: number[] = [];
const propertyIds: number[] = [];
const pointerBefore = new Map<number, string | null>();

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
const makeUser = async (role: string, withPumper: boolean): Promise<string> => {
  const { hashPassword } = require('../src/utils/password');
  const email = `t-drv20.${role}.${RUN}.${(userSeq += 1)}@test.invalid`;
  emails.push(email);
  const { rows } = await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Drv20',$1,$2,$3::user_role,true) RETURNING id`,
    [email, await hashPassword(PASSWORD), role],
  );
  const id = Number(rows[0].id);
  if (withPumper) {
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
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return ((await login.json() as any).token ?? '');
};

/** A brand-new active site nobody has serviced, so every filing is a first. */
const plantSite = async (): Promise<number> => {
  const r = await send('POST', '/properties', {
    site_address: `1 ${RUN} Overflow Lane`,
    site_city: 'Testford', site_state: 'wi', site_zip: '54932',
    payer_label: `T-DRV-21 ${RUN}`, service_interval_days: 1095,
  });
  expect(r.status).toBe(201);
  const id = Number(r.body.data.id);
  propertyIds.push(id);
  const before = await db.query(
    `SELECT to_char(last_service_date,'YYYY-MM-DD') AS d
       FROM septic_app.properties WHERE id = $1`, [id]);
  pointerBefore.set(id, before.rows[0]?.d ?? null);
  return id;
};

const eventRow = async (id: string) => (await db.query(
  `SELECT id, property_id, to_char(service_date,'YYYY-MM-DD') AS service_date, source,
          status::text AS status, gallons_pumped, waste_type_id, disposal_site_id,
          performed_by_pumper_id, client_uuid
     FROM septic_app.service_events WHERE id = $1`, [id],
)).rows[0];

const pointerOf = async (propertyId: number): Promise<string | null> => (
  await db.query(
    `SELECT to_char(last_service_date,'YYYY-MM-DD') AS d
       FROM septic_app.properties WHERE id = $1`, [propertyId])
).rows[0]?.d ?? null;

beforeAll(async () => {
  db = await connect();
  businessToday = (await db.query(
    `SELECT to_char(business_today(),'YYYY-MM-DD') AS d`)).rows[0].d;
  officeToken = await makeUser('office', false);
  driverToken = await makeUser('driver', true);
  anonDriverToken = await makeUser('driver', false);
  siteId = await plantSite();
  wasteTypeId = Number((await db.query(
    `SELECT id FROM septic_app.waste_types ORDER BY id LIMIT 1`)).rows[0].id);
  disposalSiteId = Number((await db.query(
    `SELECT id FROM septic_app.disposal_sites ORDER BY id LIMIT 1`)).rows[0].id);
}, 30_000);

afterAll(async () => {
  if (eventIds.length || pumperIds.length) {
    await db.query('BEGIN');
    await db.query(`SET LOCAL septic.ledger_repair = 'on'`);
    if (eventIds.length) {
      await db.query(`DELETE FROM septic_app.service_events WHERE id = ANY($1::bigint[])`,
        [eventIds]);
    }
    if (pumperIds.length) {
      await db.query(`DELETE FROM septic_app.pumpers WHERE id = ANY($1::int[])`, [pumperIds]);
    }
    await db.query('COMMIT');
  }
  if (propertyIds.length) {
    await db.query(`DELETE FROM septic_app.properties WHERE id = ANY($1::int[])`, [propertyIds]);
  }
  for (const email of emails) {
    await db.query('DELETE FROM septic_app.users WHERE email = $1', [email]);
  }
  await db?.end();
});

describe('T-DRV-21: filing a pump-out that was never routed', () => {
  it('a driver files it, the row says who and where, and the pointer follows', async () => {
    const site = await plantSite();
    expect(await pointerOf(site)).toBeNull();

    const r = await send('POST', '/ledger/events', {
      property_id: site, gallons_pumped: 1500, waste_type_id: wasteTypeId,
      disposal_site_id: disposalSiteId, waste_note: 'Overflow day, called direct',
    }, driverToken);
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
    nothingLeaks(r.body);
    eventIds.push(String(r.body.data.id));

    // Server's day, login's pumper, and the disposal site the county report
    // is assembled by — none of them readable from the tablet's clock or body.
    expect(r.body.data.service_date).toBe(businessToday);
    expect(r.body.data.status).toBe('completed');
    expect(r.body.data.source).toBe('app');
    expect(r.body.business_today ?? r.body.data.business_today).toBe(businessToday);

    const ev = await eventRow(String(r.body.data.id));
    expect(Number(ev.property_id)).toBe(site);
    expect(Number(ev.gallons_pumped)).toBe(1500);
    expect(Number(ev.disposal_site_id)).toBe(disposalSiteId);
    expect(ev.performed_by_pumper_id).not.toBeNull();   // the link exists
    expect(ev.service_date).toBe(businessToday);

    // SCH-16's pointer: the pump-out happened, so the queue stops asking.
    expect(await pointerOf(site)).toBe(businessToday);
    // And a complete record with no gaps says nothing extra.
    expect(r.body.warnings).toBeUndefined();
  });

  it('the flaky phone files once: a replayed client_uuid returns the first row',
    async () => {
      const site = await plantSite();
      const clientUuid = uuid();
      const body = {
        property_id: site, gallons_pumped: 900, waste_type_id: wasteTypeId,
        disposal_site_id: disposalSiteId, client_uuid: clientUuid,
      };

      const first = await send('POST', '/ledger/events', body, driverToken);
      expect(first.status).toBe(201);
      eventIds.push(String(first.body.data.id));

      // Retry the two ways a ditch does it: the identical request, twice.
      const second = await send('POST', '/ledger/events', body, driverToken);
      const third = await send('POST', '/ledger/events', body, driverToken);
      expect(second.status).toBe(200);
      expect(third.status).toBe(200);
      expect(second.body.replayed).toBe(true);
      expect(String(second.body.data.id)).toBe(String(first.body.data.id));
      expect(String(third.body.data.id)).toBe(String(first.body.data.id));

      const n = await db.query(
        `SELECT count(*)::int AS n FROM septic_app.service_events
          WHERE property_id = $1 AND source = 'app'`, [site]);
      expect(Number(n.rows[0].n)).toBe(1);
    });

  it('the office can backfill from paper — filing is authenticated, not role-locked',
    async () => {
      const site = await plantSite();
      const r = await send('POST', '/ledger/events', {
        property_id: site, gallons_pumped: 500, waste_type_id: wasteTypeId,
        disposal_site_id: disposalSiteId,
      }, officeToken);
      expect(r.status).toBe(201);
      eventIds.push(String(r.body.data.id));
      expect(r.body.data.source).toBe('app');
    });

  it('refusals name what is missing: the site, then the field the server owns',
    async () => {
      const site = await plantSite();

      const noSite = await send('POST', '/ledger/events', {
        property_id: site, gallons_pumped: 400, waste_type_id: wasteTypeId,
      }, driverToken);
      expect(noSite.status).toBe(400);
      expect(noSite.body.message).toContain('disposal_site_id');
      expect(noSite.body.required).toEqual(['disposal_site_id']);
      nothingLeaks(noSite.body);

      // DRV-08 restated at this door: the tablet does not get to decide the date.
      const withDate = await send('POST', '/ledger/events', {
        property_id: site, disposal_site_id: disposalSiteId, service_date: '2019-05-05',
      }, driverToken);
      expect(withDate.status).toBe(400);
      expect(withDate.body.message).toContain('service_date');
      nothingLeaks(withDate.body);

      // And the refusal that says "no such site" rather than leaking a schema.
      const noProp = await send('POST', '/ledger/events', {
        property_id: 999999999, disposal_site_id: disposalSiteId,
      }, driverToken);
      expect(noProp.status).toBe(404);
      expect(noProp.body.message).toContain('No site has id 999999999');
      nothingLeaks(noProp.body);

      // Nothing landed in any of them.
      const n = await db.query(
        `SELECT count(*)::int AS n FROM septic_app.service_events WHERE property_id = $1`,
        [site]);
      expect(Number(n.rows[0].n)).toBe(0);
    });

  it('gaps are warned about, never refused: no pumper link and no gallons',
    async () => {
      // A driver whose login has no pumper link is an office data gap, not a
      // crime — losing the pump-out would be worse than an anonymous row.
      const anon = await plantSite();
      const a = await send('POST', '/ledger/events', {
        property_id: anon, gallons_pumped: 700, waste_type_id: wasteTypeId,
        disposal_site_id: disposalSiteId,
      }, anonDriverToken);
      expect(a.status).toBe(201);
      eventIds.push(String(a.body.data.id));
      expect((await eventRow(String(a.body.data.id))).performed_by_pumper_id).toBeNull();
      expect(a.body.warnings?.join(' ')).toMatch(/no pumper recorded/i);

      // And no gallons is 40% of the business's own history (LED-04): filed,
      // counted, and flagged — never refused, never quiet.
      const dry = await plantSite();
      const d = await send('POST', '/ledger/events', {
        property_id: dry, waste_type_id: wasteTypeId, disposal_site_id: disposalSiteId,
      }, driverToken);
      expect(d.status).toBe(201);
      eventIds.push(String(d.body.data.id));
      expect(d.body.warnings?.join(' ')).toMatch(/no gallons/i);
    });

  it('one event per site per day: a second filing today points at the first',
    async () => {
      const site = await plantSite();
      const first = await send('POST', '/ledger/events', {
        property_id: site, disposal_site_id: disposalSiteId,
      }, driverToken);
      expect(first.status).toBe(201);
      eventIds.push(String(first.body.data.id));

      const twice = await send('POST', '/ledger/events', {
        property_id: site, disposal_site_id: disposalSiteId,
      }, driverToken);
      expect(twice.status).toBe(409);
      expect(twice.body.message).toMatch(/already has a service recorded today|correct it/);
      nothingLeaks(twice.body);

      const n = await db.query(
        `SELECT count(*)::int AS n FROM septic_app.service_events
          WHERE property_id = $1 AND source = 'app'`, [site]);
      expect(Number(n.rows[0].n)).toBe(1);
    });
});
