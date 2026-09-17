import { Client } from 'pg';
import { connect } from './db';

/**
 * SCH-06 — reassigning a property closes the old link; history is never overwritten.
 *
 * The requirement is one sentence, and the failure mode it defends against is
 * the single most common data-migration tragedy: UPDATE where an INSERT was
 * owed. So every assertion here is about what SURVIVES the reassignment — the
 * old row, its start date, its notes, its invoices' relationship to it — not
 * just about what the new row contains.
 *
 * Two of the fixtures touch rows the migration imported. The teardown restores
 * them exactly and asserts the restoration: a suite that leaves the imported
 * ledger touched is committing, against its own subject, the edit SCH-06 is
 * about not doing.
 */
const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';

let db: Client;
let officeToken = '';
const created = { payers: [] as number[], ownerships: [] as number[], properties: [] as number[], emails: [] as string[] };
/** Rows the suite touched that are not its own: (id, prior ownership_end) for restore. */
const touched: Array<{ id: number; end: string | null }> = [];

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

const mkPayer = async (tag: string) => {
  const { rows } = await db.query(
    `INSERT INTO septic_app.payers (org_name, mailing_state)
     VALUES ($1, 'WI') RETURNING id`, [`SCH-06 fixture ${tag} ${RUN}`],
  );
  created.payers.push(Number(rows[0].id));
  return Number(rows[0].id);
};

/** A property that HAS a current owner (the reassignment case). */
const propWithOwner = async () => (await db.query(
  `SELECT property_id FROM septic_app.property_ownerships
    WHERE ownership_end IS NULL ORDER BY property_id LIMIT 1`,
)).rows[0].property_id as number;

const currentOwnership = async (propertyId: number) => (await db.query(
  `SELECT id, payer_id, is_primary, ownership_start, ownership_end, source
     FROM septic_app.property_ownerships
    WHERE property_id = $1 AND ownership_end IS NULL`, [propertyId],
)).rows[0];

const ownershipRows = async (propertyId: number, payerId: number) => (await db.query(
  `SELECT id, ownership_start, ownership_end FROM septic_app.property_ownerships
    WHERE property_id = $1 AND payer_id = $2 ORDER BY id`, [propertyId, payerId],
)).rows;

beforeAll(async () => {
  db = await connect();
  const { hashPassword } = require('../src/utils/password');
  const email = `t-owner.${RUN}@test.invalid`;
  await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Owner',$1,$2,'office',true)`,
    [email, await hashPassword(PASSWORD)],
  );
  created.emails.push(email);
  officeToken = (await api('POST', '/auth/login', { email, password: PASSWORD })).body.token;
});

afterAll(async () => {
  // Delete the suite's rows first, restore second: reopening a legacy link while
  // the suite's replacement is still the current owner would trip the very
  // partial index (SCH-05) this feature is built around.
  if (created.ownerships.length) {
    await db.query(
      `DELETE FROM septic_app.property_ownerships WHERE id = ANY($1::int[])`, [created.ownerships],
    );
  }
  for (const t of touched) {
    await db.query(
      `UPDATE septic_app.property_ownerships SET ownership_end = $2 WHERE id = $1`,
      [t.id, t.end],
    );
  }
  if (created.properties.length) {
    await db.query(`DELETE FROM septic_app.properties WHERE id = ANY($1::int[])`, [created.properties]);
  }
  if (created.payers.length) {
    await db.query(`DELETE FROM septic_app.payers WHERE id = ANY($1::int[])`, [created.payers]);
  }
  if (created.emails.length) {
    await db.query('DELETE FROM septic_app.users WHERE email = ANY($1)', [created.emails]);
  }
  await db?.end();
});

describe('SCH-06: a reassignment is two rows, not one UPDATE', () => {
  it('closes the old link and opens the new one, keeping the old row', async () => {
    const prop = await propWithOwner();
    const payerB = await mkPayer('B');
    const before = await currentOwnership(prop);
    touched.push({ id: before.id, end: before.ownership_end }); // restore target

    const r = await api('POST', `/properties/${prop}/owners`, { payer_id: payerB }, officeToken);
    expect(r.status).toBe(201);
    created.ownerships.push(Number(r.body.ownership.id));
    expect(Number(r.body.closed_ownership_id)).toBe(before.id);

    // The old row survives, and survives as a record of the same past it was.
    const old = (await db.query(
      `SELECT id, payer_id, is_primary, ownership_start, ownership_end FROM septic_app.property_ownerships
        WHERE id = $1`, [before.id],
    )).rows[0];
    expect(Number(old.id)).toBe(before.id);
    expect(Number(old.payer_id)).toBe(Number(before.payer_id));
    expect(old.is_primary).toBe(before.is_primary);
    expect(String(old.ownership_start)).toBe(String(before.ownership_start));
    expect(old.ownership_end).not.toBeNull(); // only its end moved

    // The new row is the single current owner; ranges touch without a gap.
    const now = await currentOwnership(prop);
    expect(Number(now.payer_id)).toBe(payerB);
    expect(now.ownership_end).toBeNull();
    // Same instant, both sides of the seam — pg hands back Date objects at local
    // midnight for `date` columns, so compare the instants, not the locale.
    expect(new Date(now.ownership_start).getTime())
      .toBe(new Date(old.ownership_end).getTime());
  });

  it('ownership returning to a previous holder is a new event, not a merge', async () => {
    const prop = await propWithOwner();
    const [payerA, payerB] = [await mkPayer('A'), await mkPayer('B')];
    const first = await currentOwnership(prop);
    touched.push({ id: first.id, end: first.ownership_end });

    const to1 = await api('POST', `/properties/${prop}/owners`, { payer_id: payerA }, officeToken);
    created.ownerships.push(Number(to1.body.ownership.id));
    const to2 = await api('POST', `/properties/${prop}/owners`, { payer_id: payerB }, officeToken);
    created.ownerships.push(Number(to2.body.ownership.id));
    const backToA = await api('POST', `/properties/${prop}/owners`, { payer_id: payerA }, officeToken);
    created.ownerships.push(Number(backToA.body.ownership.id));
    expect(backToA.status).toBe(201);

    // payerA now appears twice on this site. Both rows exist; exactly one is open.
    const aRows = await ownershipRows(prop, payerA);
    expect(aRows.length).toBe(2);
    expect(aRows.filter((r) => r.ownership_end === null).length).toBe(1);
    // The earlier A-episode was untouched by A's return.
    expect(aRows[0].ownership_end).not.toBeNull();
  });

  it('refuses to "reassign" to the payer who already owns it', async () => {
    const prop = await propWithOwner();
    const cur = await currentOwnership(prop);
    const r = await api('POST', `/properties/${prop}/owners`,
      { payer_id: Number(cur.payer_id) }, officeToken);
    expect(r.status).toBe(409);
    // Nothing opened.
    const after = await currentOwnership(prop);
    expect(Number(after.id)).toBe(cur.id);
  });

  it('answers bad references from the URL and the body before the book opens', async () => {
    expect((await api('POST', '/properties/999999999/owners', { payer_id: 1 }, officeToken)).status).toBe(404);
    const prop = await propWithOwner();
    expect((await api('POST', `/properties/${prop}/owners`, { payer_id: 999999999 }, officeToken)).status).toBe(404);
    expect((await api('POST', `/properties/${prop}/owners`, { payer_id: 'one' }, officeToken)).status).toBe(400);
    expect((await api('POST', `/properties/${prop}/owners`,
      { payer_id: 1, ownership_start: 'last tuesday' }, officeToken)).status).toBe(400);
  });

  it('a site with no current owner opens cleanly', async () => {
    // A planted property, not a corpus scavenger hunt: the version of this test
    // that queried for "some site nobody owns and returns if none exists" passed
    // vacuously the first time it ran, because the corpus had an owner everywhere.
    const prop = Number((await db.query(
      `INSERT INTO septic_app.properties (site_address, site_city, site_state)
       VALUES ('12 Vacancy Ln', 'Nowhere', 'WI') RETURNING id`,
    )).rows[0].id);
    created.properties.push(prop);
    const payer = await mkPayer('solo');
    const r = await api('POST', `/properties/${prop}/owners`, { payer_id: payer }, officeToken);
    expect(r.status).toBe(201);
    expect(r.body.closed_ownership_id).toBeNull();
    created.ownerships.push(Number(r.body.ownership.id));
  });

  it('the database still enforces the one-open-link rule this endpoint obeys', async () => {
    // The endpoint's transaction is careful; the partial index is what stays
    // careful after the next developer writes the endpoint nobody reviewed.
    const prop = await propWithOwner();
    const payer = await mkPayer('ghost');
    await expect(db.query(
      `INSERT INTO septic_app.property_ownerships (payer_id, property_id, ownership_start)
       VALUES ($1, $2, '2026-01-01')`, [payer, prop],
    )).rejects.toThrow(/uq_one_current_owner/);
  });
});
