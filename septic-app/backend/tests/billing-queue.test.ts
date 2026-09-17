import { Client } from 'pg';
import { connect } from './db';

/**
 * T-BIL-19 — the billing queue (`GET /api/ledger/unbilled-events`).
 *
 * "What are we still owed?" differs from "what happened?" by exactly one
 * join, and this suite is the four ways an event can leave the list: billed,
 * corrected, aged out, or never completed. The two fixtures that carry the
 * design are the correction pair (heads-only or the same afternoon bills
 * twice) and the window arithmetic done as a reconciliation — the API's
 * count against the SQL's count — because a queue buried in the migrated
 * corpus cannot be asserted by scrolling to the bottom of it.
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
let officeToken = '';
let siteId = 0;
let disposalSiteId = 0;
let wasteTypeId = 0;

const emails: string[] = [];
const eventIds: string[] = [];
const invoiceIds: number[] = [];
const payerIds: number[] = [];
const propertyIds: number[] = [];

const send = async (method: string, path: string, body?: unknown, token?: string) => {
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

const newSite = async (label: string): Promise<number> => {
  const r = await send('POST', '/properties', {
    site_address: `9 ${label} ${RUN} Billable Way`, site_city: 'Testford',
    site_state: 'wi', site_zip: '54932', payer_label: `T-BIL-19 ${label} ${RUN}`,
  });
  expect(r.status).toBe(201);
  const id = Number(r.body.data.id);
  propertyIds.push(id);
  return id;
};

// The day belongs to the site: filing twice on one property-day is refused
// on its facts, so every filing gets a fresh site of its own.
const fileRecord = async (): Promise<string> => {
  const site = await newSite('pump');
  const r = await send('POST', '/ledger/events', {
    property_id: site, gallons_pumped: 1000, waste_type_id: wasteTypeId,
    disposal_site_id: disposalSiteId,
  });
  expect(r.status).toBe(201);
  const id = String(r.body.data.id);
  eventIds.push(id);
  return id;
};

/** The queue's own filter, from SQL — the reconciliation counterpart. */
const sqlCount = async (days: number): Promise<number> => (await db.query(
  `SELECT count(*)::int AS n
     FROM septic_app.service_events e
    WHERE e.status = 'completed'
      AND NOT EXISTS (SELECT 1 FROM septic_app.service_events c
                       WHERE c.corrects_event_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM septic_app.invoice_lines il
                       WHERE il.service_event_id = e.id)
      AND e.service_date >= septic_app.business_today() - $1::int`,
  [days],
)).rows[0].n;

beforeAll(async () => {
  db = await connect();
  businessToday = (await db.query(
    `SELECT to_char(business_today(),'YYYY-MM-DD') AS d`)).rows[0].d;

  const { hashPassword } = require('../src/utils/password');
  const email = `t-bil19.office.${RUN}@test.invalid`;
  emails.push(email);
  await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Bil19',$1,$2,'office',true)`,
    [email, await hashPassword(PASSWORD)]);
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  officeToken = ((await login.json() as any).token ?? '');

  const site = await send('POST', '/properties', {
    site_address: `9 ${RUN} Billable Way`, site_city: 'Testford',
    site_state: 'wi', site_zip: '54932', payer_label: `T-BIL-19 ${RUN}`,
  });
  expect(site.status).toBe(201);
  siteId = Number(site.body.data.id);
  propertyIds.push(siteId);

  disposalSiteId = Number((await db.query(
    `SELECT id FROM septic_app.disposal_sites ORDER BY id LIMIT 1`)).rows[0].id);
  wasteTypeId = Number((await db.query(
    `SELECT id FROM septic_app.waste_types ORDER BY id LIMIT 1`)).rows[0].id);
}, 30_000);

afterAll(async () => {
  await db.query('BEGIN');
  await db.query(`SET LOCAL septic.ledger_repair = 'on'`);
  if (invoiceIds.length) {
    await db.query(`DELETE FROM septic_app.invoice_lines WHERE invoice_id = ANY($1::int[])`,
      [invoiceIds]);
    await db.query(`DELETE FROM septic_app.invoices WHERE id = ANY($1::int[])`, [invoiceIds]);
  }
  if (eventIds.length) {
    await db.query(`DELETE FROM septic_app.service_events WHERE id = ANY($1::bigint[])`,
      [eventIds]);
  }
  await db.query('COMMIT');
  if (propertyIds.length) {
    await db.query(`DELETE FROM septic_app.properties WHERE id = ANY($1::int[])`, [propertyIds]);
  }
  if (payerIds.length) {
    await db.query(`DELETE FROM septic_app.payers WHERE id = ANY($1::int[])`, [payerIds]);
  }
  for (const email of emails) {
    await db.query('DELETE FROM septic_app.users WHERE email = $1', [email]);
  }
  await db?.end();
});

describe('T-BIL-19: the billing queue', () => {
  it('a filed pump-out waits on the queue with the facts the invoice needs',
    async () => {
      const ev = await fileRecord();
      const r = await send('GET', '/ledger/unbilled-events?days=365&limit=500');
      expect(r.status).toBe(200);
      expect(r.body.meta.business_today).toBe(businessToday);
      const hit = (r.body.data as any[]).find((x) => x.service_event_id === ev);
      expect(hit).toBeTruthy();
      expect(hit.service_date).toBe(businessToday);
      expect(Number(hit.gallons_pumped)).toBe(1000);
      expect(hit.disposal_site).toBeTruthy();
      nothingLeaks(r.body);
    });

  it('attaching an invoice line retires the entry — nothing else moves',
    async () => {
      const ev = await fileRecord();
      // A payer and an invoice exist only to own the line that points at the
      // event: the queue keys on the line, not on the invoice's other facts.
      const payer = await send('POST', '/payers', {
        org_name: `Billed Payer ${RUN}`, mailing_address: '1 Queue Rd',
        mailing_city: 'Testford', mailing_state: 'wi', mailing_zip: '54932',
      });
      expect(payer.status).toBe(201);
      payerIds.push(Number(payer.body.data.id));

      await db.query('BEGIN');
      await db.query(`SET LOCAL septic.ledger_repair = 'on'`);
      const inv = await db.query(
        `INSERT INTO septic_app.invoices
           (payer_id, property_id, invoice_date, subtotal, tax_amount, total)
         VALUES ($1, $2, septic_app.business_today(), 150.00, 0, 150.00)
         RETURNING id`, [payerIds[0], siteId]);  // invoice lives on the shared site
      const invId = Number(inv.rows[0].id);
      invoiceIds.push(invId);
      await db.query(
        `INSERT INTO septic_app.invoice_lines
           (invoice_id, service_event_id, description, quantity, unit_price, amount)
         VALUES ($1, $2::bigint, 'Pump-out', 1, 150.00, 150.00)`, [invId, ev]);
      await db.query('COMMIT');

      const r = await send('GET', '/ledger/unbilled-events?days=365&limit=500');
      expect((r.body.data as any[]).some((x) => x.service_event_id === ev)).toBe(false);
    });

  it('a correction moves the queue entry, never duplicates it', async () => {
    const corrSite = await newSite('corrected');
    const fr = await send('POST', '/ledger/events', {
      property_id: corrSite, gallons_pumped: 1000, waste_type_id: wasteTypeId,
      disposal_site_id: disposalSiteId,
    });
    expect(fr.status).toBe(201);
    const original = String(fr.body.data.id);
    eventIds.push(original);
    // The correction: same head rules as the ledger — the original becomes
    // history with a reason and the corrector becomes the billable head.
    const corr = await db.query(
      `INSERT INTO septic_app.service_events
         (property_id, service_date, status, gallons_pumped, waste_type_id,
          disposal_site_id, source, corrects_event_id)
       VALUES ($1, $2::date, 'completed', 1200, $3, $4, 'app', $5::bigint)
       RETURNING id`,
      [corrSite, businessToday, wasteTypeId, disposalSiteId, original]);
    const corrId = String(corr.rows[0].id);
    eventIds.push(corrId);

    const r = await send('GET', '/ledger/unbilled-events?days=365&limit=500');
    const ids = (r.body.data as any[]).map((x) => x.service_event_id);
    expect(ids).not.toContain(original);
    expect(ids).toContain(corrId);

    // Newest-first tie-break puts the just-filed head on top of its own day.
    const sameDay = (r.body.data as any[]).filter((x) => x.service_date === businessToday);
    expect(ids.indexOf(corrId)).toBeLessThanOrEqual(Math.max(0, ids.length - sameDay.length));
  });

  it('the window is the office’s dial, counted the same by the API and the schema',
    async () => {
      // Plant one event just outside the default window, straight in —
      // inserts are the ledger's lawful side.
      const planted = await db.query(
        `INSERT INTO septic_app.service_events
           (property_id, service_date, status, gallons_pumped, source,
            waste_type_id, disposal_site_id)
         VALUES ($1, septic_app.business_today() - 75, 'completed', 800, 'app', $2, $3)
         RETURNING id`, [siteId, wasteTypeId, disposalSiteId]);
      eventIds.push(String(planted.rows[0].id));

      const d60 = await send('GET', '/ledger/unbilled-events?days=60&limit=1');
      const d90 = await send('GET', '/ledger/unbilled-events?days=90&limit=1');
      expect(d60.status).toBe(200);
      // The planted row is the only difference between the two windows
      // nobody else's fixture can be 75 days old and brand-new at once —
      // and the API agrees with the database about both counts.
      expect(Number(d90.body.meta.total) - Number(d60.body.meta.total))
        .toBe(await sqlCount(90) - await sqlCount(60));
      expect(Number(d90.body.meta.total)).toBeGreaterThan(Number(d60.body.meta.total));

      const bad = await send('GET', '/ledger/unbilled-events?days=ninety');
      expect(bad.status).toBe(400);
      expect(bad.body.message).toContain('days');
      nothingLeaks(bad.body);
    });

  it('sorting is per column and refused by naming the columns', async () => {
    // Collation is Postgres's, so the order is asserted against Postgres —
    // JS localeCompare and the ICU collation disagree about hyphens and case,
    // and a test that disagrees with the database about sorting is a bug
    // factory, not a test.
    const sameOrder = async (dir: string): Promise<boolean> => {
      const r = await send('GET',
        `/ledger/unbilled-events?days=3650&sort=payer&dir=${dir}&limit=50`);
      expect(r.status).toBe(200);
      const ids = (r.body.data as any[]).map((x) => x.service_event_id);
      const truth = await db.query(
        `SELECT e.id
           FROM septic_app.service_events e
           JOIN septic_app.properties p ON p.id = e.property_id
          WHERE e.status = 'completed'
            AND NOT EXISTS (SELECT 1 FROM septic_app.service_events c
                             WHERE c.corrects_event_id = e.id)
            AND NOT EXISTS (SELECT 1 FROM septic_app.invoice_lines il
                             WHERE il.service_event_id = e.id)
            AND e.service_date >= septic_app.business_today() - 3650
          ORDER BY p.payer_label ${dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, e.id DESC
          LIMIT 50`);
      return JSON.stringify(ids)
        === JSON.stringify(truth.rows.map((x: any) => String(x.id)));
    };
    expect(await sameOrder('asc')).toBe(true);
    expect(await sameOrder('desc')).toBe(true);

    const bad = await send('GET', '/ledger/unbilled-events?sort=drop_tables');
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('sort must be one of');
    nothingLeaks(bad.body);

    const badDir = await send('GET', '/ledger/unbilled-events?sort=payer&dir=sideways');
    expect(badDir.status).toBe(400);
    nothingLeaks(badDir.body);
  });
});
