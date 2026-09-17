import { Client } from 'pg';
import { connect } from './db';

/**
 * AUT-11 — logout invalidates the session server-side.
 *
 * Design in one sentence: a per-user `tokens_invalid_before` marker raised on
 * logout, compared against the token's `iat` inside `authenticate`. The cases
 * below are the boundary arithmetic of that sentence; migration 0018 explains
 * why the marker is truncated-up-and-forward-one-second.
 *
 * Runs with no sleeps on purpose. The interesting failure is "revocation
 * depends on wall-clock distance from the mint", and only back-to-back calls
 * can show a token die while it is younger than a second.
 */
const API = process.env.API_URL_ROOT || 'http://localhost:3001/api';
const AUTH = `${API}/auth`;

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';

let db: Client;
const created: string[] = [];

const mkUser = async (tag: string, role: string, active = true) => {
  const email = `t-${tag}.${RUN}@test.invalid`; // .invalid is reserved
  const { hashPassword } = require('../src/utils/password');
  await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','User',$1,$2,$3,$4)`,
    [email, await hashPassword(PASSWORD), role, active],
  );
  created.push(email);
  return email;
};

const login = async (email: string): Promise<string> => {
  const res = await fetch(`${AUTH}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return (await res.json() as any).token;
};

const get = async (path: string, token: string) =>
  (await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })).status;

const logout = async (token: string) =>
  (await fetch(`${AUTH}/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status;

beforeAll(async () => { db = await connect(); });

afterAll(async () => {
  if (created.length) await db.query('DELETE FROM septic_app.users WHERE email = ANY($1)', [created]);
  await db?.end();
});

describe('AUT-11: logout revokes the token it was given', () => {
  let email: string;

  beforeAll(async () => { email = await mkUser('revoked', 'driver'); });

  it('a token works before logout and 401s after, on every protected surface', async () => {
    const token = await login(email);
    expect(await get('/auth/me', token)).toBe(200);

    expect(await logout(token)).toBe(200);

    expect(await get('/auth/me', token)).toBe(401);
    // Not just /me — the point is the whole session, including the surface a
    // stolen tablet calls.
    expect(await get('/properties', token)).toBe(401);
    expect(await get('/dispatch/today', token)).toBe(401);
  });

  it('a fresh login right after logout works (revocation is per generation, not a kill-switch)', async () => {
    const token = await login(email);
    await logout(token);
    const fresh = await login(email);
    expect(await get('/auth/me', fresh)).toBe(200);
    // Same second, most likely — the marker is truncated up and forward one
    // second precisely so this case cannot flake.
  });

  it('a second logout never resurrects the first generation', async () => {
    const first = await login(email);
    await logout(first);
    const second = await login(email);
    await logout(second);
    expect(await get('/auth/me', first)).toBe(401);
    expect(await get('/auth/me', second)).toBe(401);
    expect(await get('/auth/me', await login(email))).toBe(200);
  });

  it('logout with no token is refused, and revoking twice is not an error', async () => {
    expect((await fetch(`${AUTH}/logout`, { method: 'POST' })).status).toBe(401);
    const token = await login(email);
    await logout(token);
    expect(await logout(token)).toBe(401); // the token is dead; it cannot log out again
  });
});

describe('AUT-11 × AUT-02: deactivation reaches live tokens', () => {
  it('a valid token is refused the moment the account is deactivated, without expiry', async () => {
    const email = await mkUser('deact', 'office');
    const token = await login(email);
    expect(await get('/auth/me', token)).toBe(200);

    await db.query('UPDATE septic_app.users SET is_active = false WHERE email = $1', [email]);
    expect(await get('/auth/me', token)).toBe(401);

    // And login itself stays a 403 with its own message (AUT-02 unchanged).
    const res = await fetch(`${AUTH}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(res.status).toBe(403);
  });
});

describe('AUT-11 regression: the JWT boundary is unmoved (AUT-03/04)', () => {
  it('missing, malformed and foreign tokens still 401, marker or no marker', async () => {
    const email = await mkUser('jwtbound', 'driver');
    const token = await login(email);
    await logout(token); // account now carries a marker; the checks must not soften

    const statuses: number[] = [];
    for (const headers of [
      {},
      { Authorization: 'Bearer' },
      { Authorization: 'Bearer nope.nope.nope' },
      { Authorization: `Bearer ${token.slice(0, -2)}xx` },
    ]) {
      statuses.push((await fetch(`${AUTH}/me`, { headers })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401]);
  });
});
