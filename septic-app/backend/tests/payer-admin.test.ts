import { Client } from 'pg';
import { connect } from './db';

/**
 * T-SCH-12 — the office can add a biller.
 *
 * The distinction under test is the one `payers.controller.ts` has always
 * drawn: typing into a search box finds people, a form creates them. So this
 * suite creates, but its spine is the promise *after* creation — the new
 * row is searchable, it is assignable (the first ownership row of a new
 * site: close-nothing, open-one), and it is the same payer in both reads,
 * by id, not by a name the search happens to match.
 *
 * Teardown deletes ownership, payer and site, in that order and again in
 * cascade — a leaked biller shows up in someone else's dropdown and teaches
 * them to distrust it, which is the outcome SCH-12 exists to prevent.
 */
const API = process.env.API_URL_ROOT || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';

let db: Client;
let officeToken = '';
let driverToken = '';
const emails: string[] = [];
const payerIds: number[] = [];
const propertyIds: number[] = [];

const mkUser = async (tag: string, role: string) => {
  const email = `t-${tag}.${RUN}@test.invalid`;
  const { hashPassword } = require('../src/utils/password');
  await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Payer',$1,$2,$3,true)`,
    [email, await hashPassword(PASSWORD), role],
  );
  emails.push(email);
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return ((await res.json()) as any).token;
};

const send = async (method: string, path: string, token: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: ((await res.json().catch(() => ({}))) as any) ?? {} };
};

const createPayer = async (body: Record<string, unknown>) => {
  const r = await send('POST', '/payers', officeToken, body);
  if (r.status === 201) payerIds.push(r.body.data.id);
  return r;
};

beforeAll(async () => {
  db = await connect();
  officeToken = await mkUser('payer-off', 'office');
  driverToken = await mkUser('payer-drv', 'driver');
});

afterAll(async () => {
  if (propertyIds.length) {
    await db.query('DELETE FROM septic_app.property_ownerships WHERE property_id = ANY($1)',
      [propertyIds]);
    await db.query('DELETE FROM septic_app.properties WHERE id = ANY($1)', [propertyIds]);
  }
  if (payerIds.length) {
    await db.query('DELETE FROM septic_app.property_ownerships WHERE payer_id = ANY($1)',
      [payerIds]);
    await db.query('DELETE FROM septic_app.payers WHERE id = ANY($1)', [payerIds]);
  }
  if (emails.length) await db.query('DELETE FROM septic_app.users WHERE email = ANY($1)', [emails]);
  await db?.end();
});

describe('T-SCH-12: adding a biller', () => {
  it('lands the row and answers in the shape the search will show', async () => {
    const r = await createPayer({
      first_name: 'Justin', last_name: 'Whitty', mailing_state: 'wi',
      mailing_address: '3489 Brooks Rd', mailing_city: 'Oshkosh', mailing_zip: '54904',
    });
    expect(r.status).toBe(201);
    expect(r.body.data.name).toBe('Justin Whitty');
    expect(r.body.data.sites_owned).toBe(0);
    // Normalised on the way in, like a site's state — the legacy corpus is why.
    expect(r.body.data.mailing_state).toBe('WI');
    // pg checks the server is telling the truth.
    const [row] = (await db.query(
      'SELECT first_name, last_name FROM septic_app.payers WHERE id = $1',
      [r.body.data.id],
    )).rows;
    expect([row.first_name, row.last_name]).toEqual(['Justin', 'Whitty']);
  });

  it('is immediately findable by the search that could not find it before', async () => {
    const created = await createPayer({ org_name: `Whitty Holdings ${RUN}` });
    const search = await send('GET', `/payers?q=${encodeURIComponent(RUN)}`, officeToken);
    expect(search.status).toBe(200);
    const hit = search.body.data.find((p: any) => p.id === created.body.data.id);
    expect(hit).toBeDefined();
    expect(hit.name).toBe(`Whitty Holdings ${RUN}`);
  });

  it('a biller answers to the name on the paper, not to whatever the org field says', async () => {
    // What actually happened when the office typed "None" into Organization
    // for a customer named Jim Swanson: the stored org outranked the person
    // completely — the dropdown read "None", searches for "Swanson" and
    // "Swanson, Jim" returned rows nobody could recognise, and only the
    // address found him again. Each clause below is that afternoon, kept
    // honest: both names show when both exist, and either word order finds
    // him, comma or no comma.
    const r = await createPayer({
      org_name: 'None', first_name: 'Jim', last_name: `Swanson ${RUN}`,
      mailing_address: '1234 Alberta Cove', mailing_city: 'Oshkosh',
      mailing_state: 'WI', mailing_zip: '54904',
    });
    expect(r.status).toBe(201);
    expect(r.body.data.name).toBe(`Jim Swanson ${RUN} — None`);

    const find = async (q: string) => {
      const s = await send('GET', `/payers?q=${encodeURIComponent(q)}`, officeToken);
      return s.body.data.some((p: any) => p.id === r.body.data.id);
    };
    expect(await find('Swanson')).toBe(true);
    expect(await find(`Jim Swanson ${RUN}`)).toBe(true); // the order the mouth says
    expect(await find(`Swanson ${RUN}, Jim`)).toBe(true); // the order the ledger writes
  });

  it('is assignable: the first owner of a new site is an open-one, not a close-and-open', async () => {
    const site = await send('POST', '/properties', officeToken, {
      site_address: `5 ${RUN} Rental Row`,
    });
    expect(site.status).toBe(201);
    propertyIds.push(site.body.data.id);

    const biller = await createPayer({ first_name: 'Justin', last_name: `Whitty ${RUN}` });
    const assign = await send('POST', `/properties/${site.body.data.id}/owners`, officeToken,
      { payer_id: biller.body.data.id });
    expect(assign.status).toBe(201);
    // No previous row existed, so nothing was closed — the empty-state door.
    expect(assign.body.closed_ownership_id).toBeNull();

    const owners = await send('GET', `/properties/${site.body.data.id}/owners`, officeToken);
    expect(owners.body.data).toHaveLength(1);
    expect(owners.body.data[0].payer_name).toBe(`Justin Whitty ${RUN}`);
    expect(owners.body.data[0].current).toBe(true);

    // One current owner (SCH-05) then survives a second event the same way
    // the reassignment screen files it.
    const second = await createPayer({ org_name: `Second Biller ${RUN}` });
    const again = await send('POST', `/properties/${site.body.data.id}/owners`, officeToken,
      { payer_id: second.body.data.id });
    expect(again.status).toBe(201);
    expect(again.body.closed_ownership_id).not.toBeNull();
  });

  it('refuses to invent an address-less nobody, and rejects the fields it does not own', async () => {
    const noName = await send('POST', '/payers', officeToken, { mailing_city: 'Oshkosh' });
    expect(noName.status).toBe(400);
    expect(noName.body.error).toContain('name');

    const badState = await send('POST', '/payers', officeToken,
      { org_name: 'X', mailing_state: 'Wiscosin' });
    expect(badState.status).toBe(400);
    expect(badState.body.error).toContain('mailing_state');

    // The legacy billing number is a natural key of the old app, not a
    // sequence to hand out.
    const legacyNo = await send('POST', '/payers', officeToken,
      { org_name: 'X', legacy_billing_no: 9001 });
    expect(legacyNo.status).toBe(400);
    expect(legacyNo.body.error).toContain('legacy_billing_no');
  });

  it('tolerates two households named Whitty, because that is the real world', async () => {
    // The refusal this suite does NOT implement, pinned: a UNIQUE on a name
    // would make the same-named-but-different decisions for the office, and
    // the search's sites_owned ranking exists to disambiguate instead.
    const a = await createPayer({ first_name: 'Justin', last_name: `Twice ${RUN}` });
    const b = await createPayer({ first_name: 'Justin', last_name: `Twice ${RUN}` });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.data.id).not.toBe(a.body.data.id);
  });

  it('is office-gated: a driver cannot mint billers from a tablet', async () => {
    const r = await send('POST', '/payers', driverToken, { org_name: `nope ${RUN}` });
    expect(r.status).toBe(403);
  });
});
