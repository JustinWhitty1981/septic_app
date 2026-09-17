import { Client } from 'pg';
import { connect } from './db';

/**
 * BIL-16 — the one company row, now holding not only the tax but the terms.
 *
 * The sales-tax half of this table is proven in bids.test (the rate stamps onto
 * a signed document and cannot be re-traded after approval). What lives here is
 * the half the office had no screen for: NET-days and the monthly late fee the
 * mailed invoice prints as its own disclosure. They are company facts (set once,
 * `updated_by` names who), the same reason the rate is not retyped per form.
 *
 * The happy path asserts the numbers the controller hands BACK, not a re-read of
 * the shared row: bids.test owns `sales_tax_rate` and touches `updated_by` on
 * that same one row from another worker, so a read-after-write here would be a
 * race dressed up as an assertion. Validation is what this endpoint actually is
 * for — the bounds and the "nothing was changed" promises.
 */
const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';

let db: Client;
let officeToken = '';
const created: string[] = [];

const api = async (method: string, path: string, body?: any, token?: string) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: ((await res.json().catch(() => ({}))) as any) ?? {} };
};

beforeAll(async () => {
  db = await connect();
  const email = `t-settings.${RUN}@test.invalid`;
  const { hashPassword } = require('../src/utils/password');
  await db.query(
    `INSERT INTO septic_app.users (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Settings',$1,$2,'office',true)`, [email, await hashPassword(PASSWORD)],
  );
  created.push(email);
  officeToken = (await api('POST', '/auth/login', { email, password: PASSWORD })).body.token;
});

afterAll(async () => {
  // Return the terms to what the migration seeded so no sibling suite observes a
  // figure this one invented; delete the login; close the client. Each step is
  // independent so a throw cannot leave pg open (the green-looking red / hang).
  try { await db.query(
    `UPDATE septic_app.company_settings
        SET payment_term_days = 30, late_fee_rate_monthly = 0.0150,
            company_name = 'Ziegelbauer Septic', logo_media_id = NULL,
            address = NULL, email = NULL, phone = NULL, updated_by = NULL
      WHERE id = 1`); } catch { /* best effort */ }
  try { if (created.length) await db.query(
    `DELETE FROM septic_app.users WHERE email = ANY($1)`, [created]); } catch { /* best effort */ }
  try { await db?.end(); } catch { /* closed */ }
});

describe('BIL-16: the company terms the invoice prints', () => {
  it('answers a reader with the rate and the two term fields together', async () => {
    // The read is open to any *authenticated* account (a driver may ask the rate on
    // a job site) — not to the anonymous web, so it still needs the login header.
    const { status, body } = await api('GET', '/settings', undefined, officeToken);
    expect(status).toBe(200);
    expect(body.data.sales_tax_rate).toMatch(/^\d+\.\d+$/);
    expect(Number.isInteger(body.data.payment_term_days)).toBe(true);
    expect(body.data.late_fee_rate_monthly).toMatch(/^\d+\.\d+$/);
  });

  it('the office sets net-days and the monthly late fee once, and they are read back', async () => {
    const { status, body } = await api('PATCH', '/settings/payment-terms',
      { payment_term_days: 21, late_fee_rate_monthly: '0.0250' }, officeToken);
    expect(status).toBe(200);
    expect(body.data.payment_term_days).toBe(21);
    expect(body.data.late_fee_rate_monthly).toBe('0.0250');
    // Provenance is a column, not a memory — but the shared row's writer is a
    // moving target under bids.test, so assert only that the write was attributed.
    expect(body.data.updated_by).not.toBeNull();
  });

  it('a day count beyond the calendar is refused before the row is touched', async () => {
    // Land a known value first, so "nothing was changed" is measured against a
    // figure this test controls and not against whatever a sibling test left.
    const seed = await api('PATCH', '/settings/payment-terms',
      { payment_term_days: 30, late_fee_rate_monthly: '0.0150' }, officeToken);
    expect(seed.status).toBe(200);
    for (const bad of [-1, 366, 12.5]) {
      const { status, body } = await api('PATCH', '/settings/payment-terms',
        { payment_term_days: bad, late_fee_rate_monthly: '0.0150' }, officeToken);
      expect(status).toBe(400);
      expect(body.message).toMatch(/payment_term_days/);
    }
    // The refusal promised "nothing was changed" — the row still holds the seeded 30.
    const [row] = (await db.query(
      `SELECT payment_term_days AS d FROM septic_app.company_settings WHERE id = 1`)).rows;
    expect(Number(row.d)).toBe(30);
  });

  it('a percent typed into the monthly-rate field is refused by teaching the conversion', async () => {
    const { status, body } = await api('PATCH', '/settings/payment-terms',
      { payment_term_days: 30, late_fee_rate_monthly: '1.5' }, officeToken);
    expect(status).toBe(400);
    expect(body.message).toMatch(/0\.015, not 1\.5/);
  });

  it('a rate finer than the invoice can round is refused', async () => {
    const { status, body } = await api('PATCH', '/settings/payment-terms',
      { payment_term_days: 30, late_fee_rate_monthly: '0.00001' }, officeToken);
    expect(status).toBe(400);
    expect(body.message).toMatch(/4 decimal places/);
  });
});

// 0037: the row answers one more question — who the company is, on paper. The
// name, contact block and logo pointer print on every invoice (BIL-08) and bid
// (BIL-15); before this they were two hardcoded strings that disagreed with
// each other. Identity columns belong to no sibling suite, so unlike the terms
// above these may be read back from the row.
describe('BIL-16: the letterhead identity the papers print', () => {
  it('answers a reader with the identity fields beside the rates', async () => {
    const { status, body } = await api('GET', '/settings', undefined, officeToken);
    expect(status).toBe(200);
    expect(typeof body.data.company_name).toBe('string');
    expect(body.data.company_name.length).toBeGreaterThan(0);
    for (const field of ['logo_media_id', 'address', 'email', 'phone']) {
      expect(field in body.data).toBe(true);
    }
  });

  it('the office sets name and contact once, and they read back stamped', async () => {
    const { status, body } = await api('PATCH', '/settings/company', {
      company_name: 'T Ziegelbauer LLC', address: '1 Test Rd, Elkhart IN',
      email: 'office@test.invalid', phone: '(574) 555-0100',
    }, officeToken);
    expect(status).toBe(200);
    expect(body.data.company_name).toBe('T Ziegelbauer LLC');
    expect(body.data.address).toBe('1 Test Rd, Elkhart IN');
    expect(body.data.email).toBe('office@test.invalid');
    expect(body.data.phone).toBe('(574) 555-0100');
    expect(body.data.updated_by).not.toBeNull();
  });

  it('null clears a contact field', async () => {
    const { status, body } = await api('PATCH', '/settings/company',
      { email: null }, officeToken);
    expect(status).toBe(200);
    expect(body.data.email).toBeNull();
  });

  it('a field the caller invented is refused by name, and the row keeps what it had', async () => {
    const seed = await api('PATCH', '/settings/company',
      { phone: '(574) 555-0999' }, officeToken);
    expect(seed.status).toBe(200);
    const { status, body } = await api('PATCH', '/settings/company',
      { fax: '555-1212' }, officeToken);
    expect(status).toBe(400);
    expect(body.message).toMatch(/fax/);
    const [row] = (await db.query(
      `SELECT phone FROM septic_app.company_settings WHERE id = 1`)).rows;
    expect(row.phone).toBe('(574) 555-0999');
  });

  it('a logo id that names no stored image is refused by naming the id', async () => {
    const { status, body } = await api('PATCH', '/settings/company',
      { logo_media_id: 999999999 }, officeToken);
    expect(status).toBe(404);
    expect(body.message).toMatch(/No uploaded image has id 999999999/);
    const [row] = (await db.query(
      `SELECT logo_media_id AS l FROM septic_app.company_settings WHERE id = 1`)).rows;
    expect(row.l).toBeNull();
  });
});
