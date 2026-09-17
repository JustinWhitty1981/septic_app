import { Client } from 'pg';
import { connect } from './db';

/**
 * Auth, over HTTP, against the running server.
 *
 * These exercise the real middleware and the real database rather than mocked
 * services, because every auth bug found so far lived in the seam between them
 * (a column the entity declared but the table did not; an enum value the entity
 * defaulted to that the table rejected). A mocked test passed through all of it.
 */
const BASE = process.env.API_URL || 'http://localhost:3001/api/auth';

// Unique per run so repeat runs cannot collide, and so cleanup is exact.
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const emailFor = (tag: string) => `t-${tag}.${RUN}@test.invalid`; // .invalid is reserved

const post = async (
  path: string,
  body: any,
): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // `body: any` on purpose: fetch types json() as unknown under Node 20's undici
  // types, and asserting on unknown makes every expectation noisy.
  return { status: res.status, body: ((await res.json().catch(() => ({}))) as any) ?? {} };
};

const PASSWORD = 'Correc7-Passw0rd!';

let db: Client;
const created: string[] = [];

const mkUser = async (tag: string, role: string, active = true, password = PASSWORD) => {
  const email = emailFor(tag);
  const { hashPassword } = require('../src/utils/password');
  await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','User',$1,$2,$3,$4)`,
    [email, await hashPassword(password), role, active],
  );
  created.push(email);
  return email;
};

beforeAll(async () => {
  db = await connect();
});

afterAll(async () => {
  if (created.length) {
    await db.query('DELETE FROM septic_app.users WHERE email = ANY($1)', [created]);
  }
  await db?.end();
});

describe('login', () => {
  let adminEmail: string;

  beforeAll(async () => {
    adminEmail = await mkUser('admin', 'admin');
  });

  it('returns 200 and a token for correct credentials', async () => {
    const r = await post('/login', { email: adminEmail, password: PASSWORD });
    expect(r.status).toBe(200);
    expect(typeof r.body.token).toBe('string');
    expect(r.body.user).toMatchObject({ email: adminEmail, role: 'admin' });
    expect(r.body.user.password_hash).toBeUndefined();
  });

  it('AUT-05: gives an indistinguishable answer for unknown user and wrong password', async () => {
    const unknown = await post('/login', { email: `nobody.${RUN}@test.invalid`, password: PASSWORD });
    const wrong = await post('/login', { email: adminEmail, password: 'WrongPassword1!' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('AUT-02: refuses an inactive account and issues no token', async () => {
    const email = await mkUser('offduty', 'driver', false);
    const r = await post('/login', { email, password: PASSWORD });
    expect(r.status).toBe(403);
    expect(r.body.token).toBeUndefined();
  });

  it('AUT-09: records last_login_at', async () => {
    await db.query('UPDATE septic_app.users SET last_login_at = NULL WHERE email = $1', [adminEmail]);
    await post('/login', { email: adminEmail, password: PASSWORD });
    const { last_login_at } = (
      await db.query('SELECT last_login_at FROM septic_app.users WHERE email = $1', [adminEmail])
    ).rows[0];
    expect(last_login_at).not.toBeNull();
  });

  it('rejects a malformed body instead of throwing', async () => {
    expect((await post('/login', {})).status).toBeGreaterThanOrEqual(400);
    expect((await post('/login', { email: 'not-an-email', password: PASSWORD })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('AUT-01: registration cannot mint privilege', () => {
  it('ignores a role supplied by the client', async () => {
    const email = emailFor('escalate');
    const r = await post('/register', {
      first_name: 'M', last_name: 'R', email, password: PASSWORD, role: 'admin',
    });
    expect([200, 201]).toContain(r.status);
    created.push(email);
    expect(r.body.user.role).toBe('driver');
    const stored = (await db.query('SELECT role FROM septic_app.users WHERE email = $1', [email])).rows[0];
    expect(stored.role).toBe('driver');
  });

  it('still cannot escalate through a differently-named field', async () => {
    const email = emailFor('escalate2');
    const r = await post('/register', {
      first_name: 'M', last_name: 'R', email, password: PASSWORD, user_role: 'admin', isAdmin: true,
    });
    created.push(email);
    expect(r.body.user?.role ?? 'driver').toBe('driver');
  });
});

describe('AUT-03 / AUT-04: the protected route', () => {
  let token: string;
  let email: string;

  beforeAll(async () => {
    email = await mkUser('viewer', 'office');
    const r = await post('/login', { email, password: PASSWORD });
    token = r.body.token;
  });

  it('accepts a valid token and returns the current user', async () => {
    const res = await fetch(`${BASE}/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user.email).toBe(email);
  });

  it('rejects a missing, malformed, or foreign token', async () => {
    const statuses = [];
    for (const headers of [{}, { Authorization: 'Bearer' }, { Authorization: 'Bearer nope.nope.nope' }]) {
      statuses.push((await fetch(`${BASE}/me`, { headers })).status);
    }
    expect(statuses).toEqual([401, 401, 401]);
  });
});
