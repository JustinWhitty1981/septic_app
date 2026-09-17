import { Client } from 'pg';
import { connect } from './db';
import { join } from 'path';
import { readFileSync, readdirSync } from 'fs';

/**
 * NF-11 — a server error must not describe the server.
 *
 * Found by logging in and asking for data. Every business route answered with
 * Postgres' own words:
 *
 *   GET /api/customers  ->  {"error":"relation \"septic_app.customers\" does not exist"}
 *   GET /api/properties ->  {"error":"column property.address does not exist"}
 *
 * The routes sit behind `authenticate` with no role check, so a driver token — the
 * lowest-privilege credential there is, and what a stolen tablet holds — was enough to
 * enumerate table and column names and confirm which ones exist.
 *
 * Three layers, because each catches what the others cannot: a source scan that fails
 * the moment someone reintroduces the pattern, a unit test on the helper proving it
 * cannot echo, and a live request so the claim is about the running server rather than
 * about what the source appears to do.
 */

const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const SRC = join(__dirname, '..', 'src');
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Fragments that only appear when a database or ORM error has been passed through
 * verbatim. Deliberately narrow: 'column' alone would fire on ordinary prose about a
 * report column, so these are the phrases Postgres and TypeORM actually emit.
 */
const LEAKS = [
  'septic_app',
  'legacy.',
  'relation "',
  'does not exist',
  'column "',
  'violates foreign key',
  'duplicate key value',
  'null value in column',
  'QueryFailedRunner',
  'QueryFailedError',
  'EntityPropertyNotFound',
  'was not found in',
  'at Function.',
  'at Object.<anonymous>',
];

// ------------------------------------------------------------------ source scan

describe('NF-11 source scan', () => {
  function tsFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
    );
  }

  it('the controllers are actually there to scan', () => {
    // Without this the loop below passes vacuously on an empty or renamed tree,
    // which is the failure mode that made the old checklist guard useless.
    //
    // The threshold was 4 and is now 1. Stage 3 deleted four of the six controllers
    // — customer, appointment, inventory, compliance — because every table they
    // described had been deliberately excluded from the new schema. Lowering this is
    // the correct response to deleting dead code; leaving it at 4 would have made the
    // suite resist the thing it was supposed to protect.
    expect(tsFiles(join(SRC, 'controllers')).length).toBeGreaterThan(1);
  });

  it('no controller hands an error message to the client', () => {
    const offenders: string[] = [];
    for (const f of [...tsFiles(join(SRC, 'controllers')), ...tsFiles(join(SRC, 'middleware'))]) {
      const src = readFileSync(f, 'utf8');
      // Anything that reads a thrown error's message and puts it in a response body.
      if (/error:\s*\w+\.message/.test(src)) offenders.push(f.replace(SRC + '/', ''));
    }
    expect(offenders).toEqual([]);
  });

  it('auth.controller.ts, which was already correct, is still correct', () => {
    // It returned a fixed string and logged the real error. That is the pattern the
    // rest were moved onto, so it is asserted rather than assumed.
    const src = readFileSync(join(SRC, 'controllers', 'auth.controller.ts'), 'utf8');
    expect(src).toMatch(/Internal server error/);
    expect(src).not.toMatch(/error:\s*\w+\.message/);
  });
});

// ------------------------------------------------------------------- the helper

describe('NF-11 internalError', () => {
  const { internalError } = require('../src/utils/errors');

  it('never repeats what it was given', () => {
    const real = 'relation "septic_app.customers" does not exist';
    const out: string = internalError(new Error(real));
    for (const leak of LEAKS) expect(out).not.toContain(leak);
    expect(out).toMatch(/^Internal error [0-9A-F]{8}$/);
  });

  it('gives the caller something to quote that the log can find', () => {
    const a: string = internalError(new Error('x'));
    const b: string = internalError(new Error('x'));
    expect(a).not.toBe(b); // a shared constant would tie a report to no specific event
  });

  it('writes the detail to the log, since it no longer returns it', () => {
    // The old catch blocks logged nothing. If the helper swallowed the error instead
    // of logging it, this change would have traded a leak for an outage nobody can
    // diagnose — a worse outcome than the one it fixed.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const err = new Error('boom');
      err.stack = 'Error: boom\n    at Thing.<anonymous> (thing.ts:4:11)';
      const ref = internalError(err) as string;
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = String(spy.mock.calls[0][0]);
      expect(logged).toContain(ref.replace('Internal error ', 'E'));
      expect(logged).toContain('thing.ts:4');
    } finally {
      spy.mockRestore();
    }
  });

  it('survives being thrown something that is not an Error', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const v of [undefined, null, 'a string', 42, {}]) {
        expect(() => internalError(v)).not.toThrow();
      }
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------- live requests

describe('NF-11 over HTTP', () => {
  let db: Client;
  let token = '';
  let email = '';

  beforeAll(async () => {
    db = await connect();
    // Registered rather than seeded: /auth/register is public and always yields the
    // lowest-privilege role, so the token used here is the weakest one an attacker
    // could plausibly hold. If the schema leaks to this, it leaks to everyone.
    email = `t-leak.${RUN}@test.invalid`;
    const res = await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        first_name: 'Leak', last_name: 'Probe', email, password: 'Correc7-Passw0rd!',
      }),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    token = body?.token ?? '';
  });

  afterAll(async () => {
    if (email) await db.query('DELETE FROM septic_app.users WHERE email = $1', [email]);
    await db?.end();
  });

  it('got a driver token to test with', () => {
    expect(token.length).toBeGreaterThan(20);
    const role = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).role;
    expect(role).toBe('driver');
  });

  /**
   * Every response body, whatever the status.
   *
   * This scanned only 5xx bodies, because five business routes used to answer with
   * Postgres' own words. Stage 3 deleted four of them and rewrote the fifth, so no
   * reachable route fails at the database any more — which is the fix, and also what
   * would have made the old version decorative: with nothing returning 5xx it compared
   * an empty list to an empty list and reported a pass.
   *
   * The invariant was never "5xx bodies are clean". It is that no response describes
   * the server. So every body is scanned, and the test fails unless it actually saw a
   * failure go by.
   */
  it('names no table or column in any response', async () => {
    const requests = [
      '/properties', '/properties/1', '/properties/due-queue?filter=overdue&limit=1',
      '/properties/search?q=road', '/properties/abc', '/properties/9999999999',
      '/properties/due-queue?filter=nope', '/properties/search?q=a',
      '/customers', '/inventory/inventory', '/compliance/dashboard',
    ];
    const leaks: string[] = [];
    let failures = 0;
    for (const r of requests) {
      const res = await fetch(`${API}${r}`, { headers: { Authorization: `Bearer ${token}` } });
      const text = await res.text();
      if (res.status >= 400) failures += 1;
      for (const leak of LEAKS) if (text.includes(leak)) leaks.push(`GET ${r} -> ${leak}`);
    }
    expect(failures).toBeGreaterThan(3);
    expect(leaks).toEqual([]);
  });

  it('still tells the caller the request failed', async () => {
    // Suppressing the detail must not mean suppressing the failure: a response that
    // hides what went wrong is a worse bug than the one being fixed. So the shape of a
    // failure is asserted rather than assumed — a body, success:false, and a message a
    // human could act on.
    //
    // The vehicle changed. This asked /customers for its 500, and that route went with
    // the tables it described. Bad requests to the routes that remain are what produce
    // a failure now, and they produce the better kind: 4xx, whose message is written
    // for the caller rather than for the log.
    const bad = [
      '/properties/abc', '/properties/9999999999',
      '/properties/due-queue?filter=nope', '/properties/search?q=a',
    ];
    let checked = 0;
    for (const r of bad) {
      const res = await fetch(`${API}${r}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBeGreaterThanOrEqual(400);
      // A client's typo is not the server's failure. 9999999999 cannot name a row, and
      // answering 500 meant discovering that in Postgres rather than in the URL.
      expect(res.status).toBeLessThan(500);
      const body = (await res.json()) as any;
      expect(body.success).toBe(false);
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
      checked += 1;
    }
    expect(checked).toBe(bad.length);
  });

  it('answers a deleted route with 404 rather than a broken 500', async () => {
    // The regression worth guarding here is silence: four route groups removed and the
    // frontend left calling them. A missing feature has to say it is missing, so the
    // absence is asserted by name rather than trusted to stay absent.
    const gone = ['/customers', '/appointments', '/inventory/inventory', '/compliance/dashboard'];
    for (const r of gone) {
      const res = await fetch(`${API}${r}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(404);
    }
  });
});
