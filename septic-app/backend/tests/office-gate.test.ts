import { Client } from 'pg';
import { connect } from './db';

/**
 * AUT-10 — the driver token, tested against the office's write surface.
 *
 * A driver token is what a stolen tablet holds: the weakest credential in the
 * system, carried on the device most likely to be lost in a ditch. Requirement:
 * it cannot change office state. Reads stay open — that is a recorded decision
 * in quarantine.ts and routes.ts, so case 4 pins the openness too; a test that
 * only proved 403 everywhere would eventually be "fixed" by gating the reads.
 *
 * The list below is the whole office-write surface as mounted in src/routes/.
 * Case 3 is what keeps the list honest: if a route disappears, the office token
 * starts getting an Express HTML 404 instead of the JSON the mounted controller
 * produces, and this suite says so rather than quietly agreeing with a 404 that
 * a driver would also have gotten.
 */
const API = process.env.API_URL_ROOT || 'http://localhost:3001/api';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';

const OFFICE_WRITES: Array<[string, string, any?]> = [
  ['POST', '/quarantine/1/resolve', {}],
  ['POST', '/quarantine/1/unresolve', {}],
  ['POST', '/routes', {}],
  ['POST', '/routes/1/stops', {}],
  // SCH-13 names its route by (driver, date) — a literal segment that must not be
  // mistaken for the ':id' shape; the driver's 403 proves which one answered.
  ['POST', '/routes/stops', { property_id: 1, driver_id: 1, route_date: '2024-12-03' }],
  ['PATCH', '/routes/1/stops', {}],
  ['DELETE', '/routes/1/stops/1', undefined],
  ['POST', '/routes/1/publish', {}],
  ['POST', '/routes/1/unpublish', {}],
  ['POST', '/users', {}],
  ['PATCH', '/users/1', {}],
  // The password-reset route too. Empty body + an id that cannot exist: the
  // sweep proves it is mounted without landing a hash on anyone.
  ['POST', '/users/999999999/password', {}],
  // LED-01/02 and BIL-05: the ledger's correction surface and the state report
  // are office-gated too — a driver cannot decide a regulatory record was wrong,
  // and a lost tablet must not read the whole ledger's aggregate in one request.
  ['POST', '/ledger/999999999/correct', { gallons_pumped: 1 }],
  ['GET', '/ledger/report', undefined],
  ['POST', '/invoices/999999999/adjust', { lines: [{ legacy_product_code: 'X', quantity: 1, unit_price: 0 }] }],
  ['POST', '/properties/999999999/owners', { payer_id: 1 }],
  // The reads the office screens were built on are gated for the same reason
  // the writes are: they name customers, debts, and regulatory history.
  ['GET', '/invoices', undefined],
  ['GET', '/invoices/999999999', undefined],
  ['GET', '/ledger/events?property_id=999999999', undefined],
  ['GET', '/ledger/lookups', undefined],
  // BIL-19: the billing queue names customers and unbilled money — same
  // reasoning as the invoice book it feeds.
  ['GET', '/ledger/unbilled-events', undefined],
  // BIL-20: creating an invoice is the most office-shaped write there is.
  // The payload is empty on purpose — the admin sweep proves the route
  // exists by getting an answer, and 400-from-validation is an answer that
  // writes nothing.
  ['POST', '/invoices', {}],
  ['GET', '/payers?q=zz', undefined],
  ['GET', '/properties/999999999/owners', undefined],
  ['GET', '/users', undefined],
  ['POST', '/invoices/999999999/payments', { amount: 1 }],
  ['PATCH', '/disposal-sites/default', { site_id: 1 }],
  ['GET', '/receivables', undefined],
  // SCH-11 / LED-07: the site register and the disposal vocabulary. Bodies are
  // deliberately empty — the admin sweep must prove the route is mounted
  // (some controller answered JSON) without mutating the corpus.
  ['POST', '/disposal-sites', {}],
  ['PATCH', '/disposal-sites/1', {}],
  ['DELETE', '/disposal-sites/999999999', undefined],
  ['POST', '/properties', {}],
  ['PATCH', '/properties/999999999', {}],
  ['POST', '/payers', {}],
  // Bids (BIL-09..16): the whole write surface. Reads stay open by the
  // quarantine/routes doctrine — a price list and a quote are not secrets.
  // Every payload here is one the admin sweep can never land: the sweep
  // proves existence by "answered, not refused", and a 400 proves it while
  // changing nothing. A real payload would make the gate test a writer —
  // and one of them (the rate) would leave the company charging tax.
  ['PATCH', '/settings/sales-tax', { sales_tax_rate: '5.5' }],
  // Out-of-range on purpose: the gate must prove the route is mounted (a 400
  // from validation is an answer) without the sweep ever landing a new rate.
  ['PATCH', '/settings/payment-terms', { payment_term_days: 999999, late_fee_rate_monthly: '9' }],
  // The sweep-safe shape again: an unrecognized field is refused by name, so the
  // admin sweep proves the route is mounted without landing a letterhead.
  ['PATCH', '/settings/company', { office_gate: 'must never land' }],
  ['POST', '/bid-items', {}],
  ['PATCH', '/bid-items/1', {}],
  ['POST', '/bids', {}],
  ['POST', '/bids/1/lines', { bid_item_id: 1, quantity: '1' }],
  ['PATCH', '/bids/1/lines/1', { quantity: '2' }],
  ['DELETE', '/bids/1/lines/1', undefined],
  ['POST', '/bids/1/approve', {}],
  ['POST', '/bids/1/decline', {}],
  ['POST', '/bids/1/convert', {}],
  // SCH-16: due-date adjustments. The sweep-safe form again — the property id
  // cannot exist, and the date cannot be anything the controller would accept
  // twice over: a gate test that lands a row would quietly schedule a lie.
  ['POST', '/properties/999999999/due-adjustments',
    { adjusted_due_date: '1999-01-01', reason: 'office-gate: must never land' }],
  ['DELETE', '/properties/999999999/due-adjustments', undefined],
];

const OPEN_READS = ['/properties', '/quarantine', '/quarantine/families', '/routes?date=2024-12-02',
  '/disposal-sites'];

let db: Client;
const created: string[] = [];
let driverToken: string;
let adminToken: string;

const login = async (email: string) =>
  ((await (await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })).json() as any).token);

const mkUser = async (tag: string, role: string) => {
  const email = `t-${tag}.${RUN}@test.invalid`;
  const { hashPassword } = require('../src/utils/password');
  await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','User',$1,$2,$3,true)`,
    [email, await hashPassword(PASSWORD), role],
  );
  created.push(email);
  return email;
};

const call = async (method: string, path: string, token: string, body?: any) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
};

beforeAll(async () => {
  db = await connect();
  driverToken = await login(await mkUser('gate-drv', 'driver'));
  adminToken = await login(await mkUser('gate-adm', 'admin'));
});

afterAll(async () => {
  if (created.length) await db.query('DELETE FROM septic_app.users WHERE email = ANY($1)', [created]);
  await db?.end();
});

describe('AUT-10: the office write surface', () => {
  for (const [method, path, body] of OFFICE_WRITES) {
    it(`driver is 403 on ${method} ${path}`, async () => {
      const r = await call(method, path, driverToken, body);
      // 403, not 401 (the token is valid; the role is not) and not 404
      // (the gate runs before the controller).
      expect(r.status).toBe(403);
    });
  }

  for (const [method, path, body] of OFFICE_WRITES) {
    it(`admin is not gated on ${method} ${path} — and the route is still mounted`, async () => {
      const r = await call(method, path, adminToken, body);
      expect(r.status).not.toBe(401);
      expect(r.status).not.toBe(403);
      // Mounted: some controller answered with JSON. An unmounted path answers
      // with Express' HTML 404 page, and a list that no longer matches the
      // router must fail here, not pass vacuously.
      expect(r.json).not.toBeNull();
    });
  }
});

describe('AUT-10: the open reads stay open (recorded decision, not drift)', () => {
  for (const path of OPEN_READS) {
    it(`driver reads ${path}`, async () => {
      const r = await call('GET', path, driverToken);
      expect(r.status).toBe(200);
    });
  }
});
