import { Client } from 'pg';
import { connect } from './db';

/**
 * AUT-12 — account administration over HTTP.
 *
 * `/api/users` is the operations surface seed-user.ts never was: admin-only,
 * role-explicit, and wired into the AUT-11 revocation check so a deactivation
 * is real the second it lands, not when the token happens to expire.
 */
const API = process.env.API_URL_ROOT || 'http://localhost:3001/api';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';
const emailFor = (tag: string) => `t-${tag}.${RUN}@test.invalid`;

let db: Client;
const created: string[] = [];
const emailsToDelete = (...e: string[]) => created.push(...e);

const mkUser = async (tag: string, role: string) => {
  const email = emailFor(tag);
  const { hashPassword } = require('../src/utils/password');
  await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','User',$1,$2,$3,true)`,
    [email, await hashPassword(PASSWORD), role],
  );
  emailsToDelete(email);
  return email;
};

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

const login = async (email: string): Promise<string> =>
  (await api('POST', '/auth/login', { email, password: PASSWORD })).body.token;

let adminToken: string;

beforeAll(async () => {
  db = await connect();
  adminToken = await login(await mkUser('adm', 'admin'));
});

afterAll(async () => {
  if (created.length) await db.query('DELETE FROM septic_app.users WHERE email = ANY($1)', [created]);
  await db?.end();
});

describe('AUT-12: create', () => {
  it('an admin creates an office account that can log in and reach office reads', async () => {
    const email = emailFor('office-new');
    const r = await api('POST', '/users', {
      first_name: 'New', last_name: 'Office', email, password: PASSWORD, role: 'office',
    }, adminToken);
    emailsToDelete(email);

    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ email, role: 'office', is_active: true });
    expect(r.body.user.password_hash).toBeUndefined();

    const token = await login(email);
    expect((await api('GET', '/quarantine', undefined, token)).status).toBe(200);
  });

  it('is admin-only: manager and driver are 403, no token is 401', async () => {
    const manager = await login(await mkUser('mgr', 'manager'));
    const driver = await login(await mkUser('drv', 'driver'));
    const body = { first_name: 'N', last_name: 'O', email: emailFor('nobody'), password: PASSWORD, role: 'office' };
    expect((await api('POST', '/users', body, manager)).status).toBe(403);
    expect((await api('POST', '/users', body, driver)).status).toBe(403);
    expect((await api('POST', '/users', body)).status).toBe(401);
  });

  it('a create body carrying a role is the gated surface — the public /register still cannot (AUT-01 line holds at the new boundary)', async () => {
    const email = emailFor('pubreg');
    const r = await api('POST', '/auth/register', {
      first_name: 'P', last_name: 'U', email, password: PASSWORD, role: 'admin',
    });
    emailsToDelete(email);
    expect(r.body.user.role).toBe('driver');
  });

  it('refuses an unknown role, a weak password, and a duplicate email — each by name', async () => {
    const base = { first_name: 'N', last_name: 'O', password: PASSWORD };
    expect((await api('POST', '/users', { ...base, email: emailFor('badrole'), role: 'superuser' }, adminToken))
      .body.error).toMatch(/role must be one of/);

    const weak = await api('POST', '/users', { ...base, email: emailFor('weak'), role: 'driver', password: 'short' }, adminToken);
    expect(weak.status).toBe(400);
    expect(weak.body.requirements.length).toBeGreaterThan(0);

    const dupe = await mkUser('dupe', 'driver');
    const d = await api('POST', '/users', { ...base, email: dupe, role: 'driver' }, adminToken);
    expect(d.status).toBe(409);
  });
});

describe('AUT-12: disable and re-enable', () => {
  it('disable kills the login AND the live token; re-enable restores the login only', async () => {
    const email = await mkUser('toggle', 'driver');
    const { id } = (await db.query('SELECT id FROM septic_app.users WHERE email = $1', [email])).rows[0];
    const token = await login(email);
    expect((await api('GET', '/auth/me', undefined, token)).status).toBe(200);

    const off = await api('PATCH', `/users/${id}`, { is_active: false }, adminToken);
    expect(off.status).toBe(200);
    expect(off.body.user.is_active).toBe(false);

    const loginAfterOff = await api('POST', '/auth/login', { email, password: PASSWORD });
    expect(loginAfterOff.status).toBe(403);
    // The AUT-11 seam: this is the line that used to be impossible.
    expect((await api('GET', '/auth/me', undefined, token)).status).toBe(401);

    const on = await api('PATCH', `/users/${id}`, { is_active: true }, adminToken);
    expect(on.body.user.is_active).toBe(true);
    expect((await api('POST', '/auth/login', { email, password: PASSWORD })).status).toBe(200);
    // ...and the dead token stays dead: re-enable restores the account, never
    // a session that was revoked while it was off.
    expect((await api('GET', '/auth/me', undefined, token)).status).toBe(401);
  });

  it('an admin cannot deactivate themself, and can still log in afterwards', async () => {
    const me = (await api('GET', '/auth/me', undefined, adminToken)).body.user;
    const r = await api('PATCH', `/users/${me.id}`, { is_active: false }, adminToken);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/your own/i);
    expect((await api('GET', '/auth/me', undefined, adminToken)).status).toBe(200);
  });

  it('refuses non-boolean is_active, and an id that cannot name a row is answered from the URL', async () => {
    expect((await api('PATCH', '/users/1', { is_active: 'yes' }, adminToken)).status).toBe(400);
    expect((await api('PATCH', '/users/999999999', { is_active: false }, adminToken)).status).toBe(404);
    expect((await api('PATCH', '/users/zero', { is_active: false }, adminToken)).status).toBe(404);
  });

  it('a manager cannot disable anyone (the gate is the whole router, not one handler)', async () => {
    const manager = await login(await mkUser('mgr2', 'manager'));
    expect((await api('PATCH', '/users/1', { is_active: false }, manager)).status).toBe(403);
  });
});

// The thread this table used to carry as an absent feature: a forgotten
// password had no way out except seed-user.ts at a keyboard (or the legacy
// answer — one shared plaintext password). The claims worth testing are that
// the reset lands CLEAN — the old password, and every session minted under
// it, die the second the new hash does — and that it lands only by an admin's
// hand.
describe('AUT-12: password reset', () => {
  const NEW_PASSWORD = 'Rotat3d-Passw0rd!';

  it('the old password and its live token die; the new one works', async () => {
    const email = await mkUser('rotate', 'driver');
    const { id } = (await db.query('SELECT id FROM septic_app.users WHERE email = $1', [email])).rows[0];
    const token = await login(email);
    expect((await api('GET', '/auth/me', undefined, token)).status).toBe(200);

    const r = await api('POST', `/users/${id}/password`, { password: NEW_PASSWORD }, adminToken);
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe(email);
    expect(r.body.user.password_hash).toBeUndefined();

    // The refused login is a credential refusal (401), not the disabled
    // account's 403 — different door, same result: the old password is gone.
    expect((await api('POST', '/auth/login', { email, password: PASSWORD })).status).toBe(401);
    // AUT-11 again: the session minted before the reset is dead mid-flight,
    // not at expiry. A reset that left this token alive would reset the
    // password and nothing else.
    expect((await api('GET', '/auth/me', undefined, token)).status).toBe(401);
    const again = await api('POST', '/auth/login', { email, password: NEW_PASSWORD });
    expect(again.status).toBe(200);
    // …and the dead token STAYS dead after the fresh login: the epoch moved,
    // it did not blink.
    expect((await api('GET', '/auth/me', undefined, token)).status).toBe(401);
  });

  it('a weak new password is refused by the creation policy, and the old one still works', async () => {
    const email = await mkUser('rotate2', 'driver');
    const { id } = (await db.query('SELECT id FROM septic_app.users WHERE email = $1', [email])).rows[0];
    const r = await api('POST', `/users/${id}/password`, { password: 'weak' }, adminToken);
    expect(r.status).toBe(400);
    expect(Array.isArray(r.body.requirements)).toBe(true);
    expect((await api('POST', '/auth/login', { email, password: PASSWORD })).status).toBe(200);
  });

  it('is admin-only, answers bad ids from the URL, and refuses a missing password', async () => {
    const driver = await login(await mkUser('rotate3', 'driver'));
    expect((await api('POST', '/users/1/password', { password: NEW_PASSWORD }, driver)).status).toBe(403);
    expect((await api('POST', '/users/1/password', { password: NEW_PASSWORD })).status).toBe(401);
    expect((await api('POST', '/users/999999999/password', { password: NEW_PASSWORD }, adminToken)).status).toBe(404);
    expect((await api('POST', '/users/zero/password', { password: NEW_PASSWORD }, adminToken)).status).toBe(404);
    expect((await api('POST', '/users/1/password', {}, adminToken)).status).toBe(400);
  });

  it('an admin can reset their OWN password — their own session dies with it', async () => {
    const email = await mkUser('adm-self', 'admin');
    const { id } = (await db.query('SELECT id FROM septic_app.users WHERE email = $1', [email])).rows[0];
    const token = await login(email);
    const r = await api('POST', `/users/${id}/password`, { password: NEW_PASSWORD }, token);
    expect(r.status).toBe(200);
    // Self-reset is allowed (unlike self-deactivation): changing your own
    // password has a safe failure mode — the epoch bump logs you out, which
    // is exactly what a password change should do to every live session.
    expect((await api('GET', '/auth/me', undefined, token)).status).toBe(401);
    expect((await api('POST', '/auth/login', { email, password: NEW_PASSWORD })).status).toBe(200);
  });
});
