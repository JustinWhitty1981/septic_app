import { Client } from 'pg';
import { connect } from './db';

/**
 * The property directory and the due queue, asked of the running server.
 *
 * Stage 3 replaced every business route with four that map to tables which exist.
 * That claim is only worth what the check behind it is worth, so this does not read
 * the controller and agree with it — it reads the same rows out of Postgres through a
 * plain pg client and demands that the two agree, which is the only way an endpoint
 * can be caught lying about what the schema says.
 *
 * It also pins two things that were decided here and would otherwise drift:
 *
 *  - Dates leave as 'YYYY-MM-DD' strings. Returned as Date objects they serialise as
 *    UTC instants, and a service due on the 1st becomes due on the previous month's
 *    last day for anyone east of Greenwich.
 *  - No response body repeats a database error (NF-11). These routes are behind
 *    `authenticate` with no role check, so a driver's tablet is enough to ask them.
 */
const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';

/** Phrases Postgres and TypeORM emit and an honest API never should. */
const LEAKS = [
  'septic_app', 'relation "', 'does not exist', 'column "', 'violates foreign key',
  'duplicate key value', 'QueryFailedRunner', 'QueryFailedError', 'at Function.',
];

let db: Client;
let token = '';
let userEmail = '';

const get = async (
  path: string, auth: boolean | string = true,
): Promise<{ status: number; body: any }> => {
  const headers: Record<string, string> = {};
  if (auth === true) headers.Authorization = `Bearer ${token}`;
  else if (typeof auth === 'string') headers.Authorization = `Bearer ${auth}`;
  const res = await fetch(`${API}${path}`, { headers });
  return { status: res.status, body: ((await res.json().catch(() => ({}))) as any) ?? {} };
};

const nothingLeaks = (body: unknown) => {
  const s = JSON.stringify(body);
  for (const leak of LEAKS) expect(s).not.toContain(leak);
};

beforeAll(async () => {
  db = await connect();
  const { hashPassword } = require('../src/utils/password');
  userEmail = `t-props.${RUN}@test.invalid`; // .invalid is reserved
  await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Props',$1,$2,'office',true)`,
    [userEmail, await hashPassword(PASSWORD)],
  );
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userEmail, password: PASSWORD }),
  });
  const body: any = await res.json().catch(() => ({}));
  token = body?.token ?? '';
});

afterAll(async () => {
  if (userEmail) await db.query('DELETE FROM septic_app.users WHERE email = $1', [userEmail]);
  await db?.end();
});

describe('the property routes are actually behind auth', () => {
  const paths = [
    '/properties', '/properties/due-queue', '/properties/search?q=road', '/properties/1',
  ];

  it('the token was really issued, or every test below is vacuous', () => {
    // Without this, a login that silently returned no token would make each route
    // answer 401, and "401 is not 500" would be reported as a pass.
    expect(token.length).toBeGreaterThan(20);
  });

  it.each(paths)('%s refuses an unauthenticated caller', async (path) => {
    const r = await get(path, false);
    expect(r.status).toBe(401);
    nothingLeaks(r.body);
  });
});

describe('GET /properties/due-queue', () => {
  it('agrees with the view, row for row, on the same page', async () => {
    // The endpoint and the database are asked the same question by two different
    // clients. If the controller filters, joins or sorts differently from v_due_queue,
    // this fails here rather than in the office.
    const r = await get('/properties/due-queue?filter=overdue&limit=25');
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBe(25);

    const rows = await db.query(
      `SELECT q.property_id, q.days_overdue,
              to_char(q.next_service_due, 'YYYY-MM-DD') AS next_service_due
         FROM septic_app.v_due_queue q
         JOIN septic_app.properties p ON p.id = q.property_id
        WHERE q.days_overdue > 0 AND q.scheduled_on IS NULL
        ORDER BY q.effective_due_date ASC, q.legacy_cust_number ASC
        LIMIT 25`,
    );
    expect(r.body.data.map((d: any) => d.property_id)).toEqual(rows.rows.map((x) => x.property_id));
    expect(r.body.data.map((d: any) => d.next_service_due)).toEqual(
      rows.rows.map((x) => x.next_service_due),
    );
  });

  it('reports the same overdue total the schema reports', async () => {
    const r = await get('/properties/due-queue?filter=overdue&limit=1');
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM septic_app.v_due_queue
        WHERE days_overdue > 0 AND scheduled_on IS NULL`,
    );
    expect(r.body.meta.overdue_total).toBe(rows[0].n);
    expect(r.body.meta.total).toBe(rows[0].n);
  });

  it('returns dates as calendar strings, never as UTC instants', async () => {
    // A Date here serialises to "2021-06-30T23:00:00.000Z" west of Greenwich and the
    // due date silently moves a day for part of the staff.
    const r = await get('/properties/due-queue?filter=all&limit=50');
    expect(r.status).toBe(200);
    for (const row of r.body.data) {
      expect(row.next_service_due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('never calls a site overdue that the view says is not due', async () => {
    const r = await get('/properties/due-queue?filter=overdue&limit=100');
    for (const row of r.body.data) {
      expect(typeof row.days_overdue).toBe('number');
      expect(row.days_overdue).toBeGreaterThan(0);
    }
  });

  it('rejects a filter it does not implement instead of guessing one', async () => {
    const r = await get('/properties/due-queue?filter=everything');
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('filter must be one of');
    nothingLeaks(r.body);
  });

  it('ignores a county_id that is not a positive integer rather than failing', async () => {
    // '' and 'abc' arrive from a browser address bar. They must not reach the SQL as
    // anything, and they must not turn into 0, which would mean "county 0".
    for (const bad of ['', 'abc', '0', '-3', '1.5']) {
      const r = await get(`/properties/due-queue?filter=overdue&limit=1&county_id=${bad}`);
      expect(r.status).toBe(200);
      expect(r.body.meta.county_id).toBeNull();
    }
  });

  it('honours limit and moves on with page', async () => {
    const a = await get('/properties/due-queue?filter=overdue&limit=5&page=1');
    const b = await get('/properties/due-queue?filter=overdue&limit=5&page=2');
    expect(a.body.data.length).toBe(5);
    expect(b.body.data.length).toBe(5);
    expect(a.body.meta.total).toBe(b.body.meta.total);
    const idsA = new Set(a.body.data.map((d: any) => d.property_id));
    for (const row of b.body.data) expect(idsA.has(row.property_id)).toBe(false);
  });
});

describe('GET /properties and /properties/search', () => {
  it('finds a site by the number a crew would say out loud', async () => {
    // legacy_cust_number is how the yard refers to a job. An endpoint that cannot
    // resolve it has answered a different question from the one that was asked.
    const { rows } = await db.query(
      `SELECT legacy_cust_number FROM septic_app.properties
        WHERE legacy_cust_number IS NOT NULL ORDER BY id LIMIT 1`,
    );
    const cust = rows[0].legacy_cust_number;
    const r = await get(`/properties/search?q=${cust}`);
    expect(r.status).toBe(200);
    expect(r.body.data.map((d: any) => d.legacy_cust_number)).toContain(cust);
  });

  it('reads a one-digit query as a customer number, not as a substring of every address', async () => {
    // The reason the length floor could not simply be lowered: '%2%' matches half the
    // street numbers in the county. A short digit string is an exact lookup or nothing.
    const r = await get('/properties/search?q=2');
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThan(0);
    expect(r.body.data[0].legacy_cust_number).toBe(2);

    const none = await get('/properties/search?q=99999999');
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual([]);
  });

  it('refuses a one-character text search instead of scanning 7,541 rows for "a"', async () => {
    for (const q of ['a', ' ', '']) {
      const r = await get(`/properties/search?q=${encodeURIComponent(q)}`);
      expect(r.status).toBe(400);
      nothingLeaks(r.body);
    }
  });

  it('lists every status when none is asked for, and only one when it is', async () => {
    const all = await get('/properties?limit=1');
    expect(all.status).toBe(200);
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM septic_app.properties`);
    expect(all.body.meta.total).toBe(rows[0].n);

    const active = await get('/properties?status=active&limit=1');
    const act = await db.query(
      `SELECT COUNT(*)::int AS n FROM septic_app.properties WHERE status = 'active'`,
    );
    expect(active.body.meta.total).toBe(act.rows[0].n);
    expect(active.body.meta.total).toBeLessThan(all.body.meta.total);
  });

  it('treats an unknown status as no filter, not as a query error', async () => {
    // The value arrives from a URL. 7,541 rows back is a worse answer than 400, but
    // only because the status list is short and checked; a wider filter would need the
    // opposite choice.
    const r = await get('/properties?status=bogus&limit=1');
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toHaveProperty('id');
  });
});

describe('GET /properties/:id', () => {
  it('returns the tanks that belong to the site it was asked about', async () => {
    const { rows } = await db.query(
      `SELECT t.property_id, COUNT(*)::int AS n FROM septic_app.tanks t
        GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY n DESC, t.property_id LIMIT 1`,
    );
    const id = rows[0].property_id;
    const r = await get(`/properties/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.data.id).toBe(id);
    expect(r.body.data.tanks.length).toBe(rows[0].n);
    for (const t of r.body.data.tanks) {
      // raw_text is the evidence the capacity was parsed from; without it a wrong
      // parse is undetectable from the API alone.
      expect(t).toHaveProperty('raw_text');
    }
  });

  it('names the owner by the row with no end date, not by the newest row', async () => {
    const { rows } = await db.query(
      `SELECT po.property_id, po.payer_id FROM septic_app.property_ownerships po
        WHERE po.ownership_end IS NULL ORDER BY po.property_id LIMIT 1`,
    );
    const r = await get(`/properties/${rows[0].property_id}`);
    expect(r.body.data.owners[0].payer_id).toBe(rows[0].payer_id);
  });

  it('says 404 for a site that does not exist, and 400 for an id that never could', async () => {
    const gone = await get('/properties/99999999');
    expect(gone.status).toBe(404);
    nothingLeaks(gone.body);

    for (const bad of ['abc', '0', '-1', '1.5', '9999999999']) {
      // 9999999999 is a well-formed number and larger than any Postgres integer. It
      // cannot name a row, so the URL has to say so; letting it reach Postgres turned
      // a client's typo into a 500 and a database round trip.
      const r = await get(`/properties/${bad}`);
      expect(r.status).toBe(400);
      nothingLeaks(r.body);
    }
  });

  it('renders every date as a calendar string, including the null ones', async () => {
    const { rows } = await db.query(
      `SELECT id FROM septic_app.properties
        WHERE last_service_date IS NOT NULL AND baffle_inlet_date IS NULL LIMIT 1`,
    );
    const r = await get(`/properties/${rows[0].id}`);
    expect(r.body.data.last_service_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.body.data.baffle_inlet_date).toBeNull();
  });
});
