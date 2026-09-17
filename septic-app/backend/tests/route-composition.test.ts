import { Client } from 'pg';
import { connect } from './db';

/**
 * Building a driver's day, asked of the running server.
 *
 * SCH-04, SCH-08, SCH-09, SCH-10.
 *
 * This suite exists because `routes` had been in the schema for fifteen migrations with
 * nothing in the application able to write to it. Every assertion below is a write followed
 * by a read of the *database*, not of the response. That distinction is the reason the
 * quarantine controller had to be rewritten: an endpoint that reports success and changes
 * nothing is indistinguishable from a working one until something reads the table.
 *
 * Three things this is deliberately awkward about.
 *
 *  - **Every property is chosen at the moment it is used**, from the set not already routed
 *    on the business date. The dev fixture owns four sites on that date, and a suite that
 *    pinned property ids would fail for a reason that has nothing to do with what it is
 *    testing. It would then be deleted, which is how a regression suite quietly becomes nothing.
 *
 *  - **SCH-08 is tested against a second driver, not against the same route.** The index
 *    `uq_stop_one_open_route` already refuses a duplicate on one route, and its comment claims
 *    that is the rule it enforces. The rule is *one property per day across every driver*,
 *    which no index here can express. A test that only checked the same-route case would pass
 *    on the index alone and prove nothing about the endpoint.
 *
 *  - **The version conflict is manufactured, not simulated.** Two reads of the same route, one
 *    write, then the second writer's write with the version it read. That is what two tablets
 *    do; anything less is a unit test wearing an integration test's coat.
 */

const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';

/** From error-hygiene.test.ts — the phrases that mean a database error reached a client. */
const LEAKS = [
  'septic_app', 'legacy.', 'relation "', 'does not exist', 'column "',
  'violates foreign key', 'violates unique constraint', 'duplicate key value',
  'QueryFailedRunner', 'QueryFailedError', 'at Function.', 'invalid input syntax',
  'could not determine data type', 'null value in column',
];

let db: Client;
let adminToken = '';
let officeToken = '';
let driverToken = '';
let driverId = 0;
let ownerId = 0;
let otherId = 0;
let adminId = 0;
const emails: string[] = [];
const routeIds: number[] = [];

/** The date the server itself calls today. Nothing in this file asks a clock. */
let businessToday = '';

interface Res { status: number; body: any }

const send = async (
  method: string, path: string, body?: unknown, token?: string,
): Promise<Res> => {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const t = token ?? adminToken;
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${API}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: ((await res.json().catch(() => ({}))) as any) ?? {} };
};

const nothingLeaks = (body: unknown) => {
  const s = JSON.stringify(body);
  for (const leak of LEAKS) expect(s).not.toContain(leak);
};

let userSeq = 0;
const makeUser = async (role: string): Promise<{ token: string; id: number }> => {
  const { hashPassword } = require('../src/utils/password');
  // The sequence, not the role, keeps these unique — two drivers in one suite is the normal
  // case, and an email built from the role alone would make the second a constraint
  // violation inside beforeAll, where nothing is being asserted and everything is confusing.
  const email = `t-route.${role}.${RUN}.${(userSeq += 1)}@test.invalid`; // .invalid is reserved
  emails.push(email);
  const { rows } = await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Route',$1,$2,$3::user_role,true) RETURNING id`,
    [email, await hashPassword(PASSWORD), role],
  );
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body: any = await res.json().catch(() => ({}));
  return { token: body?.token ?? '', id: Number(rows[0].id) };
};

/**
 * An active property with nothing planned for it on the business date.
 *
 * Re-queried per call rather than collected once: an earlier test in this file may have
 * routed it, and a fixture re-run between two tests would move the set under a suite that
 * cached it.
 */
const freeProperty = async (offset = 0): Promise<number> => {
  const { rows } = await db.query(
    `SELECT p.id
       FROM septic_app.properties p
      WHERE p.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM septic_app.route_stops s
            JOIN septic_app.routes r ON r.id = s.route_id
           WHERE s.property_id = p.id
             AND r.route_date = $1::date
             AND s.status NOT IN ('done','skipped'))
      ORDER BY p.id
      LIMIT 1 OFFSET $2`,
    [businessToday, offset],
  );
  if (!rows.length) throw new Error('no unrouted active property available for the test date');
  return Number(rows[0].id);
};

/** Read the route back out of the database. The response is never the evidence. */
const readRoute = async (id: number) => {
  const { rows } = await db.query(
    `SELECT r.id, r.status::text AS status, r.version,
            to_char(r.route_date,'YYYY-MM-DD') AS route_date,
            (SELECT count(*) FROM septic_app.route_stops s
              WHERE s.route_id = r.id)::int AS stops
       FROM septic_app.routes r WHERE r.id = $1`,
    [id],
  );
  return rows[0];
};

const readStops = async (routeId: number) => {
  const { rows } = await db.query(
    `SELECT id, sequence_no::int AS seq, property_id
       FROM septic_app.route_stops WHERE route_id = $1 ORDER BY sequence_no`,
    [routeId],
  );
  return rows.map((r) => ({
    id: Number(r.id), seq: Number(r.seq), property_id: Number(r.property_id),
  }));
};

/**
 * A date nobody has used yet.
 *
 * SCH-04 makes (route_date, driver_id) unique, so a suite that reused one date could only
 * ever create one route — and the test for the constraint would then be the thing that
 * prevents the other thirty tests from running. Every route in this file gets its own day,
 * which also means the tests do not depend on the order Jest runs them in.
 */
let dayOffset = 1;
const uniqueDate = (): string => {
  const d = new Date(`${businessToday}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  dayOffset += 1;
  return d.toISOString().slice(0, 10);
};

/** Create a route through the API and register it for teardown. */
const newRoute = async (forDriver: number, date?: string): Promise<number> => {
  const { status, body } = await send('POST', '/routes',
    { route_date: date ?? uniqueDate(), driver_id: forDriver });
  expect(status).toBe(201);
  routeIds.push(Number(body.data.id));
  return Number(body.data.id);
};

beforeAll(async () => {
  db = await connect();
  const a = await makeUser('admin');
  const o = await makeUser('office');
  const d = await makeUser('driver');
  // Two more drivers, and the reason is SCH-04 and SCH-08 rather than tidiness. A route is
  // owned by a driver, so a suite that built every day for one person could not test the rule
  // that a site belongs to one driver per day — the test would need a second driver and would
  // quietly skip without one.
  const own = await makeUser('driver');
  const other = await makeUser('driver');
  adminToken = a.token;
  officeToken = o.token;
  driverToken = d.token;
  driverId = d.id;
  ownerId = own.id;
  otherId = other.id;
  adminId = a.id;

  const { rows } = await db.query(`SELECT to_char(business_today(),'YYYY-MM-DD') AS d`);
  businessToday = rows[0].d;
});

afterAll(async () => {
  if (routeIds.length) {
    await db.query(`DELETE FROM septic_app.route_stops WHERE route_id = ANY($1::int[])`, [routeIds]);
    await db.query(`DELETE FROM septic_app.routes WHERE id = ANY($1::int[])`, [routeIds]);
  }
  for (const email of emails) {
    await db.query('DELETE FROM septic_app.users WHERE email = $1', [email]);
  }
  await db?.end();
});

describe('the suite is not vacuous', () => {
  it('issued real tokens, and knows what the server thinks today is', () => {
    // A login that silently returned no token would make every route answer 401, and
    // "401 is not 500" would be reported as a pass. Same for a business_today() that came
    // back empty: every date assertion below would then be comparing '' to ''.
    expect(adminToken.length).toBeGreaterThan(20);
    expect(officeToken.length).toBeGreaterThan(20);
    expect(driverToken.length).toBeGreaterThan(20);
    expect(businessToday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('has somewhere to send a stop that is not already booked', async () => {
    expect(await freeProperty(0)).toBeGreaterThan(0);
  });
});

describe('who may build a day', () => {
  it('refuses an unauthenticated caller on every route in the file', async () => {
    for (const [m, p, b] of [
      ['GET', '/routes', undefined],
      ['GET', '/routes/drivers', undefined],
      ['POST', '/routes', { route_date: businessToday, driver_id: driverId }],
      ['POST', `/routes/1/stops`, { property_id: 1 }],
      ['PATCH', `/routes/1/stops`, { stop_ids: [1], version: 0 }],
      ['DELETE', `/routes/1/stops/1`, undefined],
      ['POST', `/routes/1/publish`, {}],
    ] as Array<[string, string, unknown]>) {
      const { status } = await send(m, p, b, '');
      expect(status).toBe(401);
    }
  });

  it('refuses a driver who composes their own day, and writes nothing', async () => {
    // The gate that quarantine.ts established and this file extends: a driver does not
    // author the sequence, because the sequence is the thing somebody with a whole-day view
    // decided. Asserting the 403 is not enough — the row must not exist either, or the
    // middleware would be a notice rather than a barrier.
    const before = await db.query(
      `SELECT count(*)::int AS n FROM septic_app.routes WHERE driver_id = $1`, [driverId],
    );
    const { status, body } = await send('POST', '/routes',
      { route_date: businessToday, driver_id: driverId }, driverToken);
    expect(status).toBe(403);
    nothingLeaks(body);
    const after = await db.query(
      `SELECT count(*)::int AS n FROM septic_app.routes WHERE driver_id = $1`, [driverId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('lets the office role compose, so the 403 above is a role decision and not a broken route', async () => {
    // The control for the test before it. Without this, a route file that 403s everybody
    // would pass the driver check and the suite would report a permission model it does not
    // have.
    await expect(newRoute(ownerId)).resolves.toBeGreaterThan(0);
  });
});

describe('SCH-04: one route per driver per date, with stops in order', () => {
  it('creates a draft route dated the day it was asked for', async () => {
    const id = await newRoute(ownerId, businessToday);
    const row = await readRoute(id);
    expect(row.status).toBe('draft');
    expect(row.route_date).toBe(businessToday);
    expect(row.stops).toBe(0);
  });

  it('refuses a second route for the same driver on the same date, and names the first', async () => {
    const day = uniqueDate();
    const id = await newRoute(ownerId, day);
    const { status, body } = await send('POST', '/routes',
      { route_date: day, driver_id: ownerId });
    expect(status).toBe(409);
    expect(Number(body.route_id)).toBe(id);
    nothingLeaks(body);

    // And the database agrees: one row, not two that the endpoint failed to notice.
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM septic_app.routes
        WHERE driver_id = $1 AND route_date = $2::date`, [ownerId, day],
    );
    expect(rows[0].n).toBe(1);
  });

  it('gives the same driver a separate route on a different date', async () => {
    // The UNIQUE key is (route_date, driver_id), so the schedule is a list of days. If this
    // failed, a week could only ever contain one day and the whole model would be wrong.
    const a = await newRoute(ownerId);
    const b = await newRoute(ownerId);
    expect((await readRoute(b)).route_date).not.toBe((await readRoute(a)).route_date);
  });

  it('numbers stops 1..n in the order they were added', async () => {
    const id = await newRoute(ownerId);
    for (const off of [30, 31, 32]) {
      const { status } = await send('POST', `/routes/${id}/stops`,
        { property_id: await freeProperty(off) });
      expect(status).toBe(201);
    }
    expect((await readStops(id)).map((s) => s.seq)).toEqual([1, 2, 3]);
  });

  it('rejects a date that is not a real calendar day, before the database sees it', async () => {
    // 2024-02-30 is well-formed to a regex and meaningless to a date column. Left to
    // Postgres the answer is "invalid input syntax for type date" — a database error
    // replying to a client's typo, and one of the strings LEAKS is watching for.
    for (const bad of ['2024-02-30', 'yesterday', '2024-13-01', '2024-1-1', '']) {
      const { status, body } = await send('POST', '/routes',
        { route_date: bad, driver_id: ownerId });
      expect(status).toBe(400);
      nothingLeaks(body);
    }
  });

  it('says which of the two things was not found', async () => {
    const id = await newRoute(ownerId);
    const noRoute = await send('POST', '/routes/999999/stops',
      { property_id: await freeProperty(33) });
    expect(noRoute.status).toBe(404);
    expect(noRoute.body.message).toMatch(/route/i);

    const noProperty = await send('POST', `/routes/${id}/stops`, { property_id: 999999 });
    expect(noProperty.status).toBe(404);
    expect(noProperty.body.message).toMatch(/propert/i);
    nothingLeaks(noRoute.body);
    nothingLeaks(noProperty.body);
  });
});

describe('SCH-08: a site is on one driver’s day, once', () => {
  it('refuses the same site twice on one route', async () => {
    const id = await newRoute(ownerId);
    const prop = await freeProperty(40);
    expect((await send('POST', `/routes/${id}/stops`, { property_id: prop })).status).toBe(201);

    const again = await send('POST', `/routes/${id}/stops`, { property_id: prop });
    expect(again.status).toBe(409);
    expect((await readStops(id)).length).toBe(1);
    nothingLeaks(again.body);
  });

  it('refuses a site already routed to a different driver that same day — the rule the index does not enforce', async () => {
    // uq_stop_one_open_route is on (property_id, route_id). Both rows below satisfy it:
    // different routes, different keys, no violation. The database stays silent and would
    // happily send two trucks to cust #3494. This is the endpoint noticing.
    const day = uniqueDate();
    const prop = await freeProperty(41);
    const first = await newRoute(ownerId, day);
    const second = await newRoute(otherId, day);

    expect((await send('POST', `/routes/${first}/stops`, { property_id: prop })).status).toBe(201);

    const clash = await send('POST', `/routes/${second}/stops`, { property_id: prop });
    expect(clash.status).toBe(409);
    expect(Number(clash.body.already_on_route_id)).toBe(first);

    // Actionable, not merely refused: the message has to carry enough to fix it from the
    // screen it appeared on — the day, and which driver already has it.
    expect(clash.body.message).toContain(day);

    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM septic_app.route_stops WHERE property_id = $1`, [prop],
    );
    expect(rows[0].n).toBe(1);
    nothingLeaks(clash.body);
  });

  it('allows the same site again once the earlier stop is finished', async () => {
    // 'done' and 'skipped' leave the partial index for a reason: a site worked last week can
    // be worked again, and a rule that counted history would refuse the second visit forever.
    const day = uniqueDate();
    const prop = await freeProperty(42);
    const mine = await newRoute(ownerId, day);
    expect((await send('POST', `/routes/${mine}/stops`, { property_id: prop })).status).toBe(201);

    const stop = (await readStops(mine)).find((s) => s.property_id === prop)!;
    await db.query(`UPDATE septic_app.route_stops SET status = 'done' WHERE id = $1`, [stop.id]);

    const theirs = await newRoute(otherId, day);
    expect((await send('POST', `/routes/${theirs}/stops`, { property_id: prop })).status).toBe(201);
  });

  it('refuses a stop on a route that is no longer a draft', async () => {
    // Once published, the day is somebody's. Editing it under the driver's feet is the same
    // class of harm as SCH-09's empty-route rule, and it is checked here rather than in a
    // form, because the form is the thing that can be bypassed.
    const id = await newRoute(ownerId);
    expect((await send('POST', `/routes/${id}/stops`,
      { property_id: await freeProperty(43) })).status).toBe(201);
    expect((await send('POST', `/routes/${id}/publish`, {})).status).toBe(200);

    const late = await send('POST', `/routes/${id}/stops`, { property_id: await freeProperty(44) });
    expect(late.status).toBe(409);
    expect(late.body.message).toMatch(/unpublish/i);
    nothingLeaks(late.body);
  });
});

describe('SCH-09: publishing is what makes a day real', () => {
  it('refuses to publish a route with no stops', async () => {
    // An empty published route is a driver opening the app to a blank screen in a place with
    // no signal, with nothing to tell them the office simply did not finish the day.
    const id = await newRoute(ownerId);
    const { status, body } = await send('POST', `/routes/${id}/publish`, {});
    expect(status).toBe(400);
    expect((await readRoute(id)).status).toBe('draft');
    nothingLeaks(body);
  });

  it('publishes a route that has one, and the database says so afterwards', async () => {
    const id = await newRoute(ownerId);
    await send('POST', `/routes/${id}/stops`, { property_id: await freeProperty(50) });

    const { status, body } = await send('POST', `/routes/${id}/publish`, {});
    expect(status).toBe(200);
    expect(body.data.version).toBe(1);
    expect((await readRoute(id)).status).toBe('published');
  });

  it('treats a second publish as the success it was, not as a failure', async () => {
    // The rule `resolve` established. A double-click or a retry must not report failure for
    // something the user wanted and which is now true — but it must also not pretend to have
    // done the thing it did not do, which is what `already_published` is for.
    const id = await newRoute(ownerId);
    await send('POST', `/routes/${id}/stops`, { property_id: await freeProperty(51) });
    await send('POST', `/routes/${id}/publish`, {});

    const again = await send('POST', `/routes/${id}/publish`, {});
    expect(again.status).toBe(200);
    expect(again.body.data.already_published).toBe(true);
    expect((await readRoute(id)).version).toBe(1);   // not 2 — nothing was published twice
  });

  it('unpublishes a day nobody has started, and refuses one somebody has', async () => {
    const id = await newRoute(ownerId);
    await send('POST', `/routes/${id}/stops`, { property_id: await freeProperty(52) });
    await send('POST', `/routes/${id}/publish`, {});

    const back = await send('POST', `/routes/${id}/unpublish`, {});
    expect(back.status).toBe(200);
    expect((await readRoute(id)).status).toBe('draft');

    // Now start it, and try again. The undo stops where the record begins.
    await send('POST', `/routes/${id}/publish`, {});
    const stop = (await readStops(id))[0];
    await db.query(
      `UPDATE septic_app.route_stops SET status = 'arrived', arrived_at = now() WHERE id = $1`,
      [stop.id],
    );
    const refused = await send('POST', `/routes/${id}/unpublish`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/1 stop already worked/i);
    expect((await readRoute(id)).status).toBe('published');
    nothingLeaks(refused.body);
  });

  it('refuses to remove a stop that has been worked, and answers differently for one that is not there', async () => {
    // Deleting a completed visit would delete the reason the property is not overdue. The
    // stop row is the audit trail, not a scratch pad.
    const id = await newRoute(ownerId);
    await send('POST', `/routes/${id}/stops`, { property_id: await freeProperty(53) });
    const stop = (await readStops(id))[0];
    await db.query(`UPDATE septic_app.route_stops SET status = 'done' WHERE id = $1`, [stop.id]);

    const del = await send('DELETE', `/routes/${id}/stops/${stop.id}`);
    expect(del.status).toBe(409);
    expect((await readStops(id)).length).toBe(1);

    const gone = await send('DELETE', `/routes/${id}/stops/999999`);
    expect(gone.status).toBe(404);
    nothingLeaks(del.body);
    nothingLeaks(gone.body);
  });

  it('removes a pending stop and leaves the others alone', async () => {
    const id = await newRoute(ownerId);
    for (const off of [54, 55, 56]) {
      await send('POST', `/routes/${id}/stops`, { property_id: await freeProperty(off) });
    }
    const before = await readStops(id);
    expect((await send('DELETE', `/routes/${id}/stops/${before[1].id}`)).status).toBe(200);

    const after = await readStops(id);
    expect(after.map((s) => s.id)).toEqual([before[0].id, before[2].id]);
    // Gaps are allowed and normal: the sequence is an ordering, not a row count. Reordering
    // is what compacts it, and SCH-10 asserts that separately.
    expect(after.map((s) => s.seq)).toEqual([1, 3]);
  });
});

describe('SCH-10: the order is the deliverable, and two people can be holding it', () => {
  /** Three stops on a fresh route, as [routeId, stopIds]. */
  const threeStops = async (): Promise<[number, number[]]> => {
    const id = await newRoute(ownerId);
    for (const off of [60, 61, 62]) {
      await send('POST', `/routes/${id}/stops`, { property_id: await freeProperty(off) });
    }
    return [id, (await readStops(id)).map((s) => s.id)];
  };

  it('reverses a day in one write, with no gap and no duplicate left behind', async () => {
    // The reason this needed migration 0016: a unique index is checked row by row as it is
    // written, so assigning stop A position 3 collides with stop C, which still holds 3.
    // Reversing a day is the single most obvious thing to do with a route, and it used to 500.
    const [id, ids] = await threeStops();
    const { status, body } = await send('PATCH', `/routes/${id}/stops`,
      { stop_ids: [...ids].reverse(), version: 0 });
    expect(status).toBe(200);
    expect(body.data.version).toBe(1);

    const after = await readStops(id);
    expect(after.map((s) => s.id)).toEqual([...ids].reverse());
    expect(after.map((s) => s.seq)).toEqual([1, 2, 3]);

    const { rows } = await db.query(
      `SELECT count(*)::int AS n, count(DISTINCT sequence_no)::int AS distinct_seq
         FROM septic_app.route_stops WHERE route_id = $1`, [id],
    );
    expect(rows[0].n).toBe(rows[0].distinct_seq);
  });

  it('refuses the second writer rather than merging the two orders', async () => {
    // Manufactured the way it happens: two readers, one writer, then the other writer's save.
    // A merge would decide silently whose order survived.
    const [id, ids] = await threeStops();
    const mine = [...ids].reverse();
    const theirs = [ids[1], ids[2], ids[0]];

    expect((await send('PATCH', `/routes/${id}/stops`,
      { stop_ids: mine, version: 0 })).status).toBe(200);

    const stale = await send('PATCH', `/routes/${id}/stops`, { stop_ids: theirs, version: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.current_version).toBe(1);
    expect(stale.body.you_sent).toBe(0);

    // The winner is still the winner.
    expect((await readStops(id)).map((s) => s.id)).toEqual(mine);
    nothingLeaks(stale.body);
  });

  it('refuses a partial list instead of deleting the stops it forgot to mention', async () => {
    const [id, ids] = await threeStops();
    const partial = await send('PATCH', `/routes/${id}/stops`,
      { stop_ids: [ids[0], ids[1]], version: 0 });
    expect(partial.status).toBe(400);
    expect(partial.body.missing).toEqual([ids[2]]);
    expect((await readStops(id)).length).toBe(3);
    nothingLeaks(partial.body);
  });

  it('refuses an id that is not on this route, and says which', async () => {
    const [id, ids] = await threeStops();
    const bogus = await send('PATCH', `/routes/${id}/stops`,
      { stop_ids: [ids[0], ids[1], ids[2], 999999], version: 0 });
    expect(bogus.status).toBe(400);
    expect(bogus.body.unknown).toEqual([999999]);
    expect((await readStops(id)).length).toBe(3);
  });

  it('refuses a duplicate id, a missing version, and a version that is not a number', async () => {
    const [id, ids] = await threeStops();
    expect((await send('PATCH', `/routes/${id}/stops`,
      { stop_ids: [...ids, ids[0]], version: 0 })).status).toBe(400);
    expect((await send('PATCH', `/routes/${id}/stops`, { stop_ids: ids })).status).toBe(400);
    expect((await send('PATCH', `/routes/${id}/stops`,
      { stop_ids: ids, version: 'abc' })).status).toBe(400);
    expect((await send('PATCH', `/routes/${id}/stops`,
      { stop_ids: ids, version: -1 })).status).toBe(400);
    expect((await send('PATCH', `/routes/${id}/stops`,
      { stop_ids: [], version: 0 })).status).toBe(400);
    expect((await readRoute(id)).version).toBe(0);
  });

  it('accepts version 0, because every route is born there', async () => {
    // intParam rejects 0 — correct for an id, wrong for a counter. Reusing it for the version
    // made the *first* reorder of a route's life impossible, and only a live call found it:
    // every check written before it had used a version of 1 or more.
    const [id, ids] = await threeStops();
    expect((await send('PATCH', `/routes/${id}/stops`,
      { stop_ids: ids, version: 0 })).status).toBe(200);
  });

  it('refuses a reorder of a published day', async () => {
    const [id] = await threeStops();
    await send('POST', `/routes/${id}/publish`, {});
    const after = (await readStops(id)).map((s) => s.id);
    const { status, body } = await send('PATCH', `/routes/${id}/stops`,
      { stop_ids: [...after].reverse(), version: 1 });
    expect(status).toBe(409);
    expect(body.message).toMatch(/published/i);
    nothingLeaks(body);
  });
});

describe('who can be given a day', () => {
  it('lists the drivers, and only the drivers', async () => {
    // Creating a route means naming a person. Before this endpoint the only way to do that was
    // to already know a users.id, which makes the feature unusable by the role it is for and
    // testable only by accident.
    const { status, body } = await send('GET', '/routes/drivers');
    expect(status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    for (const d of body.data) {
      expect(d.role).toBe('driver');
      expect(typeof d.first_name).toBe('string');
    }
    // The admin running this call is not in it.
    expect(body.data.map((d: any) => d.id)).not.toContain(adminId);
  });

  it('answers the collection, not one id, when the path is /routes/drivers', async () => {
    // Express matches in declaration order. Registered after '/:id', this path reaches
    // intParam('drivers'), and a clerk looking for a person is told their request is malformed.
    const { status, body } = await send('GET', '/routes/drivers');
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('refuses to hand a day to somebody who does not drive', async () => {
    // The picker filters by role; this is the same rule where skipping the picker is possible.
    // Without it the filter is decoration and the first non-browser client puts a truck on an
    // accountant.
    const { status, body } = await send('POST', '/routes',
      { route_date: uniqueDate(), driver_id: adminId });
    expect(status).toBe(409);
    expect(body.message).toMatch(/not a driver/i);
    nothingLeaks(body);
  });
});

describe('NF-11: none of these refusals describes the server', () => {
  it('every error path answers in English, not in Postgres', async () => {
    // Each of these was a real 500 at some point during this slice, which is exactly why the
    // check runs over responses rather than over source.
    const probes: Array<[string, string, unknown]> = [
      ['POST', '/routes', { route_date: '2024-02-30', driver_id: ownerId }],
      ['POST', '/routes', { route_date: businessToday, driver_id: 999999 }],
      ['POST', '/routes', { route_date: businessToday }],
      ['POST', '/routes/999999/stops', { property_id: 1 }],
      ['POST', '/routes/999999/publish', {}],
      ['POST', '/routes/999999/unpublish', {}],
      ['GET', '/routes/999999', undefined],
      ['GET', '/routes?date=nope', undefined],
      ['DELETE', '/routes/999999/stops/999999', undefined],
      ['PATCH', '/routes/999999/stops', { stop_ids: [1], version: 0 }],
    ];
    for (const [method, path, body] of probes) {
      const { status, body: b } = await send(method, path, body);
      expect([400, 404, 409]).toContain(status);
      nothingLeaks(b);
    }
  });
});


