import { Client } from 'pg';
import { connect } from './db';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The quarantine queue, asked of the running server.
 *
 * Two reasons this suite is longer than the endpoints look like they deserve.
 *
 * First, it is the first write endpoint in the application, and the first place the
 * `authorize` middleware is reached. That middleware had been in the tree, unused, since
 * the routes that called it were deleted — so nothing in this repository had ever proved
 * it returns 403. A role check that has only ever been read is a role check that has only
 * ever been assumed.
 *
 * Second, the queue is the one surface where a wrong answer is indistinguishable from a
 * right one. If `resolve` silently matched no row, the row would still be open and the
 * screen would still say it was closed. So the checks below do not read the response and
 * agree with it; they read `import_quarantine` through a plain pg client and demand that
 * the two agree, which is the only way to catch an endpoint lying about a write.
 *
 * It leaves the queue exactly as it found it: the baseline is 3,876 open rows and a suite
 * that quietly closed some would make every count assertion after it meaningless.
 */
const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// The queue's assertions are facts about the migrated corpus (nine families,
// 2,944 distinct reasons, 3,876 open rows) — a fresh install's queue is
// legitimately empty, and the families endpoint's own documentation is what a
// corpus machine looks like. Same rule as the ETL suites: absent CSVs mean a
// fresh clone, which is a reason to skip. The bootstrap's fixture queue keeps
// the office-gate route check (a different file) honest either way.
const CANDIDATES = [
  '/data',                                        // the container's read-only mount
  path.resolve(__dirname, '../../..', 'data'),    // running jest on the host
];
const DATA_DIR = CANDIDATES.find((d) => fs.existsSync(path.join(d, 'tblCustDumpLog.csv')));
const suite = DATA_DIR !== undefined ? describe : describe.skip;
const PASSWORD = 'Correc7-Passw0rd!';

const LEAKS = [
  'septic_app', 'relation "', 'does not exist', 'column "', 'violates foreign key',
  'duplicate key value', 'QueryFailedRunner', 'QueryFailedError', 'at Function.',
  'could not determine data type', 'invalid input syntax',
];

let db: Client;
let adminToken = '';
let driverToken = '';
const emails: string[] = [];

/** The row this suite writes to, and the state it was found in. */
let targetId = 0;
let originalResolvedAt: Date | null = null;
let originalResolvedBy: number | null = null;

const call = async (
  method: string, path: string, auth: boolean | string = true,
): Promise<{ status: number; body: any }> => {
  const headers: Record<string, string> = {};
  if (auth === true) headers.Authorization = `Bearer ${adminToken}`;
  else if (typeof auth === 'string') headers.Authorization = `Bearer ${auth}`;
  const res = await fetch(`${API}${path}`, { method, headers });
  return { status: res.status, body: ((await res.json().catch(() => ({}))) as any) ?? {} };
};

const nothingLeaks = (body: unknown) => {
  const s = JSON.stringify(body);
  for (const leak of LEAKS) expect(s).not.toContain(leak);
};

/** Inserts a user with a known password and returns a token for it. */
const makeUser = async (role: string): Promise<string> => {
  const { hashPassword } = require('../src/utils/password');
  const email = `t-quar.${role}.${RUN}@test.invalid`; // .invalid is reserved
  emails.push(email);
  await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Quar',$1,$2,$3::user_role,true)`,
    [email, await hashPassword(PASSWORD), role],
  );
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body: any = await res.json().catch(() => ({}));
  return body?.token ?? '';
};

beforeAll(async () => {
  db = await connect();
  adminToken = await makeUser('admin');
  driverToken = await makeUser('driver');

  // Pin the row this suite will write to, and remember how it was found.
  // amount_paid_exceeds_total is a single row, which makes it the least disruptive
  // thing in the queue to practise a write against.
  const { rows } = await db.query(
    `SELECT id, resolved_at, resolved_by FROM septic_app.import_quarantine
      WHERE reason = 'amount_paid_exceeds_total' OR split_part(reason, ':', 1) = 'amount_paid_exceeds_total'
      ORDER BY id LIMIT 1`,
  );
  if (rows.length) {
    targetId = Number(rows[0].id);
    originalResolvedAt = rows[0].resolved_at;
    originalResolvedBy = rows[0].resolved_by;
  }
});

afterAll(async () => {
  if (targetId) {
    await db.query(
      `UPDATE septic_app.import_quarantine
          SET resolved_at = $2, resolved_by = $3 WHERE id = $1`,
      [targetId, originalResolvedAt, originalResolvedBy],
    );
  }
  for (const email of emails) {
    await db.query('DELETE FROM septic_app.users WHERE email = $1', [email]);
  }
  await db?.end();
});

suite('the quarantine routes are behind auth', () => {
  it('the tokens were really issued, or every check below is vacuous', () => {
    // Without this, a login that silently returned no token would make each route answer
    // 401, and "401 is not 500" would be reported as a pass.
    expect(adminToken.length).toBeGreaterThan(20);
    expect(driverToken.length).toBeGreaterThan(20);
    expect(targetId).toBeGreaterThan(0);
  });

  const paths = ['/quarantine', '/quarantine/families', '/quarantine?family=orphan_line_in_gap'];

  it.each(paths)('%s refuses an unauthenticated caller', async (path) => {
    const { status } = await call('GET', path, false);
    expect(status).toBe(401);
  });

  it('refuses an unauthenticated write, and does not perform it', async () => {
    const { status } = await call('POST', `/quarantine/${targetId}/resolve`, false);
    expect(status).toBe(401);
    const { rows } = await db.query(
      'SELECT resolved_at FROM septic_app.import_quarantine WHERE id = $1', [targetId],
    );
    expect(rows[0].resolved_at).toBeNull();
  });
});

suite('the family filter is the whole point of this endpoint', () => {
  /**
   * 3,876 rows carry 2,944 distinct `reason` strings, because the orphan_line_* codes
   * embed the invoice number. A filter built from DISTINCT reason would offer the office
   * 2,944 options, 2,936 of which appear once — a dropdown that cannot be used, which is
   * the failure this endpoint exists to prevent. So the assertion is not "the counts are
   * right" but "the choice offered is nine", and it would fail the day someone builds the
   * filter out of raw reasons instead.
   */
  it('offers nine families, not the 2,944 reasons underneath them', async () => {
    const { body } = await call('GET', '/quarantine/families');
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(9);

    const { rows } = await db.query(
      'SELECT count(DISTINCT reason)::int AS n FROM septic_app.import_quarantine',
    );
    expect(rows[0].n).toBeGreaterThan(2000); // the trap is still live in the data
    expect(body.data.length).toBeLessThan(20);
  });

  it('reports counts that match the table, row for row', async () => {
    const { body } = await call('GET', '/quarantine/families');
    const { rows } = await db.query(
      `SELECT split_part(reason, ':', 1) AS family,
              count(*)::int AS total,
              count(*) FILTER (WHERE resolved_at IS NULL)::int AS open
         FROM septic_app.import_quarantine GROUP BY 1`,
    );
    const expected = new Map(rows.map((r) => [r.family, r]));
    expect(body.data).toHaveLength(rows.length);
    for (const row of body.data) {
      const want = expected.get(row.family);
      expect(want).toBeDefined();
      expect(Number(row.total)).toBe(want.total);
      expect(Number(row.open)).toBe(want.open);
    }
  });

  it('the families sum to the whole queue, so nothing is uncounted', async () => {
    const { body } = await call('GET', '/quarantine/families');
    const sum = body.data.reduce((acc: number, r: any) => acc + Number(r.total), 0);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM septic_app.import_quarantine');
    expect(sum).toBe(rows[0].n);
  });
});

suite('the queue lists what the table holds', () => {
  it('a family filter returns exactly that family', async () => {
    const { body } = await call('GET', '/quarantine?family=service_date_unparseable&limit=50');
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) {
      expect(row.reason.startsWith('service_date_unparseable')).toBe(true);
    }
  });

  it('the total agrees with a count straight from Postgres', async () => {
    const { body } = await call('GET', '/quarantine?family=orphan_line_in_gap');
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM septic_app.import_quarantine
        WHERE split_part(reason, ':', 1) = 'orphan_line_in_gap' AND resolved_at IS NULL`,
    );
    expect(body.meta.total).toBe(rows[0].n);
  });

  it('orders by file and line number, not by the serial', async () => {
    // id records the order the transforms happened to run in. source_file + row_no is the
    // line in the CSV, which is the only thing two people can be told to go and look at.
    const { body } = await call('GET', '/quarantine?family=orphan_line_in_gap&limit=40');
    const keys = body.data.map((r: any) => `${r.source_file}:${String(r.row_no).padStart(9, '0')}`);
    expect([...keys].sort()).toEqual(keys);
  });

  it('carries the source row verbatim, which is the reason the row exists', async () => {
    const { body } = await call('GET', '/quarantine?family=orphan_line_in_gap&limit=1');
    const row = body.data[0];
    // The point of `raw` is to compare what arrived with what we decided, so the original
    // spelling of the value survives — "$175.00" with the dollar sign, not 175.
    expect(typeof row.raw).toBe('object');
    expect(Object.keys(row.raw).length).toBeGreaterThan(0);
    expect(row.reason).toContain('invoice');
  });

  it('answers a nonsense status from the URL rather than the database', async () => {
    const { status, body } = await call('GET', '/quarantine?status=anything');
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    nothingLeaks(body);
  });
});

/**
 * The first time `authorize` has run in this repository.
 *
 * It shipped in middleware/auth.ts and every caller of it was deleted in Stage 3, so until
 * now its 403 branch had been read by humans and executed by nobody. A permission check that
 * has never been executed is a decoration.
 */
suite('a driver may read the queue and may not close it', () => {
  it('reads what the office reads', async () => {
    const { status } = await call('GET', '/quarantine/families', driverToken);
    expect(status).toBe(200);
    const listed = await call('GET', '/quarantine?family=orphan_line_in_gap&limit=1', driverToken);
    expect(listed.status).toBe(200);
  });

  it('is refused on resolve, and the row stays open', async () => {
    const { status, body } = await call('POST', `/quarantine/${targetId}/resolve`, driverToken);
    expect(status).toBe(403);
    nothingLeaks(body);
    const { rows } = await db.query(
      'SELECT resolved_at FROM septic_app.import_quarantine WHERE id = $1', [targetId],
    );
    expect(rows[0].resolved_at).toBeNull();
  });

  it('is refused on unresolve too, so the gate is not one-endpoint-deep', async () => {
    const { status } = await call('POST', `/quarantine/${targetId}/unresolve`, driverToken);
    expect(status).toBe(403);
  });
});

suite('resolving writes what it claims to have written', () => {
  it('sets the timestamp and the identity, in the table not just the response', async () => {
    const { status, body } = await call('POST', `/quarantine/${targetId}/resolve`);
    expect(status).toBe(200);
    expect(body.data.already_resolved).toBe(false);

    const { rows } = await db.query(
      'SELECT resolved_at, resolved_by FROM septic_app.import_quarantine WHERE id = $1',
      [targetId],
    );
    expect(rows[0].resolved_at).not.toBeNull();
    expect(rows[0].resolved_by).not.toBeNull();
  });

  /**
   * The identity comes from the token. A body that could name `resolved_by` would make it a
   * claim rather than a record, and the one column this table has for accountability would
   * be writable by whoever held the URL.
   */
  it('ignores a resolved_by supplied by the client', async () => {
    await call('POST', `/quarantine/${targetId}/unresolve`);
    const res = await fetch(`${API}/quarantine/${targetId}/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved_by: 1 }),
    });
    expect(res.status).toBe(200);

    const { rows } = await db.query(
      `SELECT u.email FROM septic_app.import_quarantine q
         JOIN septic_app.users u ON u.id = q.resolved_by WHERE q.id = $1`,
      [targetId],
    );
    expect(rows[0].email).toContain(`admin.${RUN}`);
  });

  it('says so rather than failing when it is already resolved', async () => {
    // A double-click or a retry must not report a failure for a thing that is already true.
    const { status, body } = await call('POST', `/quarantine/${targetId}/resolve`);
    expect(status).toBe(200);
    expect(body.data.already_resolved).toBe(true);
  });

  it('moves the row between the two views, which is what draining means', async () => {
    const open = await call('GET', '/quarantine?family=amount_paid_exceeds_total&status=open');
    const closed = await call('GET', '/quarantine?family=amount_paid_exceeds_total&status=resolved');
    expect(open.body.meta.total).toBe(0);
    expect(closed.body.meta.total).toBe(1);
    expect(closed.body.data[0].resolved_by_name.length).toBeGreaterThan(0);
  });

  it('opens it again, because one wrong click should not be permanent', async () => {
    const { status } = await call('POST', `/quarantine/${targetId}/unresolve`);
    expect(status).toBe(200);
    const { rows } = await db.query(
      'SELECT resolved_at, resolved_by FROM septic_app.import_quarantine WHERE id = $1',
      [targetId],
    );
    expect(rows[0].resolved_at).toBeNull();
    expect(rows[0].resolved_by).toBeNull();
  });

  it('reports a second unresolve as already open, not as an error', async () => {
    const { status, body } = await call('POST', `/quarantine/${targetId}/unresolve`);
    expect(status).toBe(200);
    expect(body.data.already_open).toBe(true);
  });
});


suite('a URL that cannot name a row is answered from the URL', () => {
  it('404s an id that does not exist, distinctly from one already closed', async () => {
    const { status, body } = await call('POST', '/quarantine/999999999/resolve');
    expect(status).toBe(404);
    expect(body.message).toMatch(/not found/i);
    nothingLeaks(body);
  });

  it.each(['/quarantine/notanumber/resolve', '/quarantine/0/resolve', '/quarantine/-3/resolve'])(
    '%s is a 400', async (path) => {
      const { status } = await call('POST', path);
      expect(status).toBe(400);
    },
  );

  /**
   * 9999999999 is a perfectly well-formed number and does not fit in int4. Without the
   * ceiling in intParam it reaches Postgres as a literal that does not fit, comes back as a
   * database error, and the server reports a client's typo as its own failure. That is the
   * bug the property routes already had; the ceiling is asserted here so a new controller
   * cannot quietly omit it.
   */
  it('400s an id past the int4 ceiling rather than 500ing', async () => {
    const { status, body } = await call('POST', '/quarantine/9999999999/resolve');
    expect(status).toBe(400);
    nothingLeaks(body);
  });
});

suite('nothing here repeats the database', () => {
  it('no response body carries a schema name or a driver error', async () => {
    const probes: Array<[string, string]> = [
      ['GET', '/quarantine'],
      ['GET', '/quarantine/families'],
      ['GET', '/quarantine?status=nope'],
      ['GET', '/quarantine?family=%27%27'],
      ['POST', '/quarantine/999999999/resolve'],
    ];
    for (const [method, path] of probes) {
      const { body } = await call(method, path);
      nothingLeaks(body);
    }
  });

  it('a quote in the family filter is a value, not a clause', async () => {
    // Would have been a syntax error had the family been interpolated. It is bound, so the
    // honest answer is an empty queue.
    const { status, body } = await call('GET', `/quarantine?family=${encodeURIComponent("a'b")}`);
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);

  });
});

