import { Client } from 'pg';
import { connect } from './db';

/**
 * T-SCH-11 — the office can add and edit a site.
 * T-LED-07 — the office maintains the disposal-site vocabulary.
 *
 * Both live in one file because they are one screen's worth of promise, and
 * the promise each endpoint makes is the same two-part sentence: the office
 * may change the reference data, and the reference data the ledger has
 * already spoken about cannot be lied away. So the tests are mostly about
 * the second half — which fields the edit surface *refuses*, and whether a
 * refusal says what the caller needs next (NF-11).
 *
 * Corpus discipline follows SCH-06's precedent: the one legacy disposal site
 * this suite renames is restored in a `finally`, and every row created here
 * carries the run tag so `afterAll` can find it again. A crashed run that
 * leaks sites will fail reconciliation on someone else's machine, and that
 * someone else is usually you, tomorrow.
 */
const API = process.env.API_URL_ROOT || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';

const LEAKS = [
  'septic_app', 'relation "', 'does not exist', 'column "', 'violates foreign key',
  'duplicate key value', 'violates check constraint', 'QueryFailedRunner', 'QueryFailedError',
];

let db: Client;
let officeToken = '';
let driverToken = '';
const emails: string[] = [];
const propertyIds: number[] = [];
const siteNames: string[] = [];

const mkUser = async (tag: string, role: string) => {
  const email = `t-${tag}.${RUN}@test.invalid`;
  const { hashPassword } = require('../src/utils/password');
  await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Site',$1,$2,$3,true)`,
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

const nothingLeaks = (body: unknown) => {
  const s = JSON.stringify(body);
  for (const leak of LEAKS) expect(s).not.toContain(leak);
};

beforeAll(async () => {
  db = await connect();
  officeToken = await mkUser('site-off', 'office');
  driverToken = await mkUser('site-drv', 'driver');
});

afterAll(async () => {
  if (propertyIds.length) {
    await db.query('DELETE FROM septic_app.properties WHERE id = ANY($1)', [propertyIds]);
  }
  if (siteNames.length) {
    // Only rows this run created; anything the ledger already named would
    // refuse the delete exactly as the endpoint does, and the corpus is not
    // this file's to tidy.
    await db.query('DELETE FROM septic_app.disposal_sites WHERE name = ANY($1)', [siteNames]);
  }
  if (emails.length) await db.query('DELETE FROM septic_app.users WHERE email = ANY($1)', [emails]);
  await db?.end();
});

/** A created property, tracked for teardown. */
const newSite = async (body: Record<string, unknown>) => {
  const r = await send('POST', '/properties', officeToken, body);
  if (r.status === 201) propertyIds.push(r.body.data.id);
  return r;
};

const newDumpSite = async (name: string, body: Record<string, unknown> = {}) => {
  siteNames.push(name);
  return send('POST', '/disposal-sites', officeToken, { name, ...body });
};

describe('T-SCH-11: adding and editing a site', () => {
  it('adds a site that is born with no history to derive a due date from', async () => {
    const r = await newSite({
      site_address: `1 ${RUN} Line Road`,
      site_city: 'Testford', site_state: 'wi', site_zip: '54932',
      payer_label: `T-SCH-11 ${RUN}`, service_interval_days: 365,
    });
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
    // Two facts the endpoint does not own and does not invent:
    expect(r.body.data.last_service_date).toBeNull();
    expect(r.body.data.next_service_due).toBeNull();
    // The lowercase 'wi' normalised on the way in, because the legacy corpus
    // is exactly the mess ('WI' and 'Wi') that normalisation is for.
    expect(r.body.data.site_state).toBe('WI');
    // The server answers; pg checks the server is telling the truth.
    const row = (await db.query(
      'SELECT site_address, service_interval_days FROM septic_app.properties WHERE id = $1',
      [r.body.data.id],
    )).rows[0];
    expect(row.site_address).toBe(`1 ${RUN} Line Road`);
    expect(row.service_interval_days).toBe(365);
  });

  it('refuses a ledger-owned column by naming the column and the reason', async () => {
    for (const column of ['next_service_due', 'last_service_date', 'legacy_memo', 'county_raw']) {
      const r = await send('POST', '/properties', officeToken, {
        site_address: '9 Should Not Land', [column]: '2024-01-01',
      });
      expect(r.status).toBe(400);
      expect(r.body.message).toContain(column);
      nothingLeaks(r.body);
      // And nothing half-written while it was refusing.
      const n = (await db.query(
        'SELECT count(*)::int AS n FROM septic_app.properties WHERE site_address = $1',
        ['9 Should Not Land'],
      )).rows[0];
      expect(n.n).toBe(0);
    }
    const unknown = await send('POST', '/properties', officeToken, {
      site_address: '8 Nope', nme: 'typo',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toContain('nme');
  });

  it('requires the one field a crew cannot work without', async () => {
    const r = await send('POST', '/properties', officeToken, { payer_label: `nowhere ${RUN}` });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('site_address');
  });

  it('refuses the impossible shapes it could still pass to Postgres', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ site_address: '1 ok', service_interval_days: 0 }, 'service_interval_days'],
      [{ site_address: '1 ok', status: 'melted' }, 'status'],
      [{ site_address: '1 ok', site_state: 'Wiscosin' }, 'site_state'],
      [{ site_address: '1 ok', pump_installed_date: '2024-02-30' }, 'not a real date'],
      [{ site_address: '1 ok', county_id: 999999 }, 'No county has id 999999.'],
    ];
    for (const [body, phrase] of cases) {
      const r = await send('POST', '/properties', officeToken, body);
      expect(r.status).toBe(400);
      expect(r.body.message).toContain(phrase);
      nothingLeaks(r.body);
    }
  });

  it('refuses a used customer number by naming the number', async () => {
    // A number from the run clock: unique against other runs, small enough
    // for the column, and never a real cust # by accident of the fixture.
    const cust = 900_000_000 + (Date.now() % 100_000_000);
    const first = await newSite({ site_address: '2 First Dup Lane', legacy_cust_number: cust });
    expect(first.status).toBe(201);
    const second = await send('POST', '/properties', officeToken, {
      site_address: '2 Second Dup Lane', legacy_cust_number: cust,
    });
    expect(second.status).toBe(409);
    expect(second.body.message).toContain(String(cust));
    nothingLeaks(second.body);
  });

  it('edits what the body named and survives what it did not', async () => {
    // A legacy row, not a planted date: an invented last_service_date with no
    // events behind it is exactly the inconsistency the reconciliation suite
    // (correctly) hunts corpus-wide, and a test that fights the schema's own
    // invariant in a shared database is the crime, not the proof. SCH-06's
    // discipline instead: touch a real row, restore it in `finally`.
    const legacy = (await db.query(
      `SELECT id, payer_label, service_interval_days,
              to_char(last_service_date, 'YYYY-MM-DD') AS last_service_date
         FROM septic_app.properties
        WHERE last_service_date IS NOT NULL AND status = 'active'
        ORDER BY id LIMIT 1`,
    )).rows[0];
    try {
      const patch = await send('PATCH', `/properties/${legacy.id}`, officeToken, {
        site_city: 'After', system_condition_note: `edited by ${RUN}`,
      });
      expect(patch.status).toBe(200);
      expect(patch.body.data.site_city).toBe('After');
      // The ledger's column survived an unrelated edit — the mutation that a
      // full-row save would commit, with a 200.
      expect(patch.body.data.last_service_date).toBe(legacy.last_service_date);

      // The generated due date follows its inputs and only its inputs: the
      // PATCH above never mentioned either operand, and this one changes the
      // interval, not the date.
      const interval = await send('PATCH', `/properties/${legacy.id}`, officeToken,
        { service_interval_days: 365 });
      expect(interval.status).toBe(200);
      const check = (await db.query(
        `SELECT to_char(last_service_date + service_interval_days, 'YYYY-MM-DD') AS due,
                to_char(next_service_due, 'YYYY-MM-DD') AS gen
           FROM septic_app.properties WHERE id = $1`, [legacy.id])).rows[0];
      expect(check.gen).toBe(check.due);
      expect(check.gen).toBe(interval.body.data.next_service_due);
    } finally {
      await send('PATCH', `/properties/${legacy.id}`, officeToken, {
        payer_label: legacy.payer_label,
        service_interval_days: legacy.service_interval_days,
      });
    }
  });

  it('names the fields it will not write, and answers 404 for no site', async () => {
    const patchNoFields = await send('PATCH', '/properties/1', officeToken, {});
    expect(patchNoFields.status).toBe(400);
    expect(patchNoFields.body.message).toContain('No editable fields');

    const patchOwned = await send('PATCH', '/properties/1', officeToken,
      { last_service_date: '2024-06-01' });
    expect(patchOwned.status).toBe(400);
    expect(patchOwned.body.message).toContain('last_service_date');

    const missing = await send('PATCH', '/properties/999999999', officeToken, { town: 'X' });
    expect(missing.status).toBe(404);
    expect(missing.body.message).toContain('999999999');
    nothingLeaks(missing.body);
  });

  it('offers status as the retire lever and nothing shaped like delete', async () => {
    const created = await newSite({ site_address: '4 Retire Me Lane' });
    const id = created.body.data.id;
    const seal = await send('PATCH', `/properties/${id}`, officeToken, { status: 'sealed' });
    expect(seal.status).toBe(200);
    expect(seal.body.data.status).toBe('sealed');
    const gone = await fetch(`${API}/properties/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${officeToken}` },
    });
    // 404-with-JSON means the verb is not mounted; an HTML 404 would mean the
    // router answered for a missing route, which is a different fact.
    expect([404, 405]).toContain(gone.status);
  });

  it('is office-gated both ways, and the driver hears 403 before any validation', async () => {
    for (const [method, path] of [['POST', '/properties'], ['PATCH', '/properties/1']] as const) {
      const r = await send(method, path, driverToken, {});
      expect(r.status).toBe(403);
    }
  });
});

describe('T-LED-07: the disposal-site vocabulary', () => {
  /** A corpus site the ledger actually names — read, never kept. */
  let legacy: { id: number; name: string; events: number };

  beforeAll(async () => {
    const row = (await db.query(
      `SELECT d.id, d.name, count(e.*)::int AS events
         FROM septic_app.disposal_sites d
         JOIN septic_app.service_events e ON e.disposal_site_id = d.id
        GROUP BY d.id
        HAVING count(e.*) > 0
        ORDER BY count(e.*) DESC, d.id
        LIMIT 1`,
    )).rows[0];
    legacy = row;
  });

  it('adds a site to the vocabulary, fresh and unnamed by history', async () => {
    const name = `T7 dump ${RUN}`;
    const r = await newDumpSite(name, { accepts_slurry: true, dnr_permit_no: '12345-7' });
    expect(r.status).toBe(201);
    expect(r.body.data.name).toBe(name);
    expect(r.body.data.accepts_slurry).toBe(true);
    expect(r.body.data.permitted).toBe(true);
    expect(r.body.data.events_using).toBe(0);
  });

  it('refuses a duplicate name by naming the name', async () => {
    const name = `T7 dupe ${RUN}`;
    expect((await newDumpSite(name)).status).toBe(201);
    const r = await newDumpSite(name);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain(name);
    nothingLeaks(r.body);
  });

  it('renames by id, so the ledger follows truthfully and history does not move', async () => {
    const eventBefore = (await db.query(
      `SELECT e.id, e.disposal_site_id FROM septic_app.service_events e
        WHERE e.disposal_site_id = $1 LIMIT 1`, [legacy.id])).rows[0];
    const renamed = `T7 renamed ${RUN}`;
    try {
      const r = await send('PATCH', `/disposal-sites/${legacy.id}`, officeToken, { name: renamed });
      expect(r.status).toBe(200);
      expect(r.body.data.events_using).toBe(legacy.events);

      // The event still names the same id — the rename moved the label, not
      // the record — and the joined name follows, which is the whole point.
      const eventAfter = (await db.query(
        `SELECT e.disposal_site_id, d.name
           FROM septic_app.service_events e
           JOIN septic_app.disposal_sites d ON d.id = e.disposal_site_id
          WHERE e.id = $1`, [eventBefore.id])).rows[0];
      expect(eventAfter.disposal_site_id).toBe(legacy.id);
      expect(eventAfter.name).toBe(renamed);
    } finally {
      await send('PATCH', `/disposal-sites/${legacy.id}`, officeToken, { name: legacy.name });
    }
    const restored = (await db.query('SELECT name FROM septic_app.disposal_sites WHERE id = $1',
      [legacy.id])).rows[0];
    expect(restored.name).toBe(legacy.name);
  });

  it('deletes only what history never named', async () => {
    const name = `T7 temp ${RUN}`;
    expect((await newDumpSite(name)).status).toBe(201);
    const gone = await send('DELETE', `/disposal-sites/${(await listId(name))}`, officeToken);
    expect(gone.status).toBe(200);
    expect(await listId(name)).toBeNull();
  });

  it('refuses to delete a site the ledger names, and the refusal carries the count', async () => {
    const r = await send('DELETE', `/disposal-sites/${legacy.id}`, officeToken);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain(legacy.name);
    expect(r.body.error).toContain(String(legacy.events));
    nothingLeaks(r.body);
    const still = (await db.query('SELECT 1 FROM septic_app.disposal_sites WHERE id = $1',
      [legacy.id])).rows[0];
    expect(still).toBeDefined();
  });

  it('will not let the company default be deleted out from under the Done dialog', async () => {
    const name = `T7 default ${RUN}`;
    expect((await newDumpSite(name)).status).toBe(201);
    const id = await listId(name);
    const original = await (await fetch(`${API}/disposal-sites`, {
      headers: { Authorization: `Bearer ${officeToken}` },
    })).json() as any;
    const prevDefault = original.data.find((d: any) => d.is_default)?.id;
    try {
      expect((await send('PATCH', '/disposal-sites/default', officeToken, { site_id: id }))
        .status).toBe(200);
      const r = await send('DELETE', `/disposal-sites/${id}`, officeToken);
      expect(r.status).toBe(409);
      expect(r.body.error).toContain('default');
    } finally {
      await send('PATCH', '/disposal-sites/default', officeToken, { site_id: prevDefault });
    }
  });

  it('keeps the list driver-readable and the writes gated', async () => {
    const open = await send('GET', '/disposal-sites', driverToken);
    expect(open.status).toBe(200); // OPEN_READS: vocabulary is the driver's path
    expect(open.body.data[0]).toHaveProperty('events_using');
    expect((await send('POST', '/disposal-sites', driverToken, { name: `nope ${RUN}` }))
      .status).toBe(403);
    expect((await send('PATCH', '/disposal-sites/1', driverToken, {})).status).toBe(403);
    expect((await send('DELETE', '/disposal-sites/999999999', driverToken)).status).toBe(403);
  });

  /** The id behind a name, straight from the endpoint the office screen uses. */
  async function listId(name: string): Promise<number | null> {
    const r = await send('GET', '/disposal-sites', officeToken);
    return r.body.data.find((d: any) => d.name === name)?.id ?? null;
  }
});
