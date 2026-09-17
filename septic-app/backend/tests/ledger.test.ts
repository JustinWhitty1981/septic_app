import { Client } from 'pg';
import { connect } from './db';

/**
 * LED-01 / LED-02 — the ledger after it became append-only, and the report
 * generated from it.
 *
 * LED-01's requirement is a sentence about behaviour ("editing creates a
 * correcting entry, never overwrites") that has three separate failure modes,
 * and a suite that only tests the endpoint catches none of them:
 *
 *   - someone UPDATEs a row from a psql session or a fix-up script;
 *   - someone adds an endpoint that "just fixes the typo";
 *   - the correction chain forks and the report quietly double-counts.
 *
 * So the first section attacks the table directly, through pg, the way a fix-up
 * script would — the guard is in the database precisely because it cannot be
 * behind an endpoint nobody reviewed. The chain section then forks the chain on
 * purpose and requires the fork to be refused.
 *
 * LED-02's report is checked against an independent recomputation over the same
 * rows, and again after a correction lands, to prove the number follows the
 * ledger rather than a cache — the stored-tally disease that `tblStateReports`
 * actually caught the business with (P1).
 */
const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';

let db: Client;
let officeToken = '';
const created = { events: [] as string[], emails: [] as string[] };

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

/** An app-sourced, completed event on business_today, filed straight into the
 * table — inserts were always allowed, that is the whole point. */
const plantEvent = async (gallons: number | null, site: boolean) => {
  const [prop] = (await db.query(
    `SELECT id FROM septic_app.properties p
      WHERE p.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM septic_app.service_events e
                         WHERE e.property_id = p.id AND e.service_date = $1::date)
      ORDER BY p.id DESC LIMIT 1`, [businessToday],
  )).rows;
  const siteRow = site
    ? (await db.query(`SELECT id FROM septic_app.disposal_sites ORDER BY id LIMIT 1`)).rows[0].id
    : null;
  const { rows } = await db.query(
    `INSERT INTO septic_app.service_events
       (property_id, service_date, source, status, gallons_pumped, waste_type_id, disposal_site_id)
     VALUES ($1, $2::date, 'app', 'completed', $3,
             (SELECT id FROM septic_app.waste_types ORDER BY id LIMIT 1), $4)
     RETURNING id`,
    [prop.id, businessToday, gallons, siteRow],
  );
  created.events.push(String(rows[0].id));
  return { id: String(rows[0].id), property_id: prop.id, disposal_site_id: siteRow };
};

/** Delete created rows through the guard's only legal door. That the door works
 * is itself an assertion: if it does not, cleanup canaries below would lie. */
const deleteEvents = async (ids: string[]) => {
  if (!ids.length) return;
  await db.query('BEGIN');
  await db.query(`SET LOCAL septic.ledger_repair = 'on'`);
  await db.query(`DELETE FROM septic_app.service_events WHERE id = ANY($1::bigint[])`, [ids]);
  await db.query('COMMIT');
};

let businessToday = '';
let siteId = 0;

beforeAll(async () => {
  db = await connect();
  businessToday = (await db.query(`SELECT to_char(business_today(),'YYYY-MM-DD') AS d`)).rows[0].d;
  siteId = (await db.query(`SELECT id FROM septic_app.disposal_sites ORDER BY id LIMIT 1`)).rows[0].id;

  const { hashPassword } = require('../src/utils/password');
  const email = `t-ledger.${RUN}@test.invalid`;
  await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Ledger',$1,$2,'office',true)`,
    [email, await hashPassword(PASSWORD)],
  );
  created.emails.push(email);
  officeToken = (await api('POST', '/auth/login', { email, password: PASSWORD })).body.token;
});

afterAll(async () => {
  await deleteEvents(created.events);
  if (created.emails.length) {
    await db.query('DELETE FROM septic_app.users WHERE email = ANY($1)', [created.emails]);
  }
  await db?.end();
});

describe('LED-01: the table itself is append-only', () => {
  let ev: { id: string };
  beforeAll(async () => { ev = await plantEvent(1500, true); });

  it('refuses UPDATE, and the row does not move', async () => {
    await expect(db.query(
      `UPDATE septic_app.service_events SET gallons_pumped = 99999 WHERE id = $1`, [ev.id],
    )).rejects.toThrow(/append-only/i);

    const row = (await db.query(
      `SELECT gallons_pumped FROM septic_app.service_events WHERE id = $1`, [ev.id],
    )).rows[0];
    expect(Number(row.gallons_pumped)).toBe(1500);
  });

  it('refuses DELETE', async () => {
    await expect(db.query(
      `DELETE FROM septic_app.service_events WHERE id = $1`, [ev.id],
    )).rejects.toThrow(/append-only/i);
  });

  it('refuses TRUNCATE — because "truncating is not editing" describes a hole', async () => {
    await expect(db.query(
      `TRUNCATE septic_app.service_events RESTART IDENTITY CASCADE`,
    )).rejects.toThrow(/append-only/i);
  });

  it('allows the sanctioned repair door, and only inside the asking transaction', async () => {
    const { id } = await plantEvent(100, true);
    await db.query('BEGIN');
    await db.query(`SET LOCAL septic.ledger_repair = 'on'`);
    await db.query(`DELETE FROM septic_app.service_events WHERE id = $1`, [id]);
    await db.query('COMMIT');

    const gone = (await db.query(
      `SELECT 1 FROM septic_app.service_events WHERE id = $1`, [id],
    )).rows.length;
    expect(gone).toBe(0);

    // The bypass is LOCAL: a second statement, no SET, is back under the guard.
    await expect(db.query(
      `DELETE FROM septic_app.service_events WHERE id = $1`, [ev.id],
    )).rejects.toThrow(/append-only/i);
  });
});

describe('LED-01: corrections are new rows', () => {
  it('files a correction, leaves the original byte-identical, and links the pair', async () => {
    const ev = await plantEvent(1500, true);
    const before = (await db.query(
      `SELECT gallons_pumped, waste_type_id, disposal_site_id, service_date, property_id,
              status::text AS status, source
         FROM septic_app.service_events WHERE id = $1`, [ev.id],
    )).rows[0];

    const r = await api('POST', `/ledger/${ev.id}/correct`, { gallons_pumped: 2000 }, officeToken);
    expect(r.status).toBe(201);
    expect(r.body.corrected_fields).toEqual(['gallons_pumped']);
    created.events.push(String(r.body.event.id));

    const after = (await db.query(
      `SELECT gallons_pumped, waste_type_id, disposal_site_id, service_date, property_id,
              status::text AS status, source
         FROM septic_app.service_events WHERE id = $1`, [ev.id],
    )).rows[0];
    expect(after).toEqual(before);

    const corr = r.body.event;
    expect(String(corr.corrects_event_id)).toBe(String(ev.id)); // bigint serialises as string
    expect(Number(corr.gallons_pumped)).toBe(2000);
    expect(corr.source).toBe('app');
    // Identity is copied, never accepted: the correction describes the same visit.
    expect(corr.property_id).toBe(before.property_id);
    // The controller returns to_char'ed dates; the pg client returns Date objects.
    // Compare the calendars, not the representations.
    expect(String(corr.service_date)).toBe(
      new Date(before.service_date).toISOString().slice(0, 10),
    );
  });

  it('refuses a second correction of a corrected row — chains stay linear', async () => {
    const ev = await plantEvent(1500, true);
    const first = await api('POST', `/ledger/${ev.id}/correct`, { gallons_pumped: 1600 }, officeToken);
    expect(first.status).toBe(201);
    created.events.push(String(first.body.event.id));

    const again = await api('POST', `/ledger/${ev.id}/correct`, { gallons_pumped: 1700 }, officeToken);
    expect(again.status).toBe(409);
    expect(again.body.current_head).toBe(Number(first.body.event.id));
    expect(again.body.error).toMatch(/current record|head/i);

    // The head is correctable; the chain grows forward, never sideways.
    const chain3 = await api(
      'POST', `/ledger/${first.body.event.id}/correct`, { gallons_pumped: 1800 }, officeToken,
    );
    expect(chain3.status).toBe(201);
    created.events.push(String(chain3.body.event.id));
    expect(Number(chain3.body.event.gallons_pumped)).toBe(1800);
  });

  it('refuses an empty correction, a non-correctable field, and an unknown id — by name', async () => {
    const ev = await plantEvent(1500, true);

    expect((await api('POST', `/ledger/${ev.id}/correct`, {}, officeToken)).status).toBe(400);

    const idSwap = await api('POST', `/ledger/${ev.id}/correct`, { property_id: 2 }, officeToken);
    expect(idSwap.status).toBe(400);
    expect(idSwap.body.error).toMatch(/not correctable/i);

    const ghost = await api('POST', '/ledger/999999999/correct', { gallons_pumped: 1 }, officeToken);
    expect(ghost.status).toBe(404);
  });

  it('requires a site when the record being corrected never named one', async () => {
    // A legacy-shaped row with the gap LED-03 is about. The correction is the
    // office declaring the missing fact, so the correction must carry it; the
    // original keeps its NULL (it is history), the app-sourced head does not.
    const [prop] = (await db.query(
      `SELECT id FROM septic_app.properties p
        WHERE NOT EXISTS (SELECT 1 FROM septic_app.service_events e
                           WHERE e.property_id = p.id AND e.service_date = $1::date)
        ORDER BY p.id DESC LIMIT 1`, [businessToday],
    )).rows;
    const legacy = (await db.query(
      `INSERT INTO septic_app.service_events (property_id, service_date, source, status, gallons_pumped)
       VALUES ($1, $2::date, 'legacy_import', 'completed', 900) RETURNING id`,
      [prop.id, businessToday],
    )).rows[0];
    created.events.push(String(legacy.id));

    const bare = await api('POST', `/ledger/${legacy.id}/correct`, { gallons_pumped: 900 }, officeToken);
    expect(bare.status).toBe(400);
    expect(bare.body.required).toContain('disposal_site_id');

    const fixed = await api(
      'POST', `/ledger/${legacy.id}/correct`,
      { gallons_pumped: 900, disposal_site_id: siteId }, officeToken,
    );
    expect(fixed.status).toBe(201);
    created.events.push(String(fixed.body.event.id));
    expect(Number(fixed.body.event.disposal_site_id)).toBe(Number(siteId));
  });
});

describe('LED-02: the report is generated from the ledger, not stored beside it', () => {
  /** The same question, asked differently: a scalar recomputation the controller
   * does not share a single character of SQL with beyond the required predicate
   * (completed, window, heads only). */
  const recompute = async (from: string, to: string) => (await db.query(
    `SELECT count(*)::int                                   AS events,
            count(*) FILTER (WHERE gallons_pumped IS NULL)::INT AS no_gallons,
            coalesce(sum(gallons_pumped), 0)::float8         AS gallons
       FROM septic_app.service_events e
      WHERE e.status = 'completed' AND e.service_date BETWEEN $1::date AND $2::date
        AND NOT EXISTS (SELECT 1 FROM septic_app.service_events c
                         WHERE c.corrects_event_id = e.id)`,
    [from, to],
  )).rows[0];

  it('answers exactly what the rows say', async () => {
    const ev = await plantEvent(1234.5, true);
    const r = await api('GET', `/ledger/report?from=${businessToday}&to=${businessToday}`, undefined, officeToken);
    expect(r.status).toBe(200);
    const want = await recompute(businessToday, businessToday);
    expect(r.body.totals.events).toBe(want.events);
    expect(r.body.totals.events_without_gallons).toBe(want.no_gallons);
    expect(Number(r.body.totals.gallons)).toBeCloseTo(want.gallons, 1);
  });

  it('follows a correction: the report moves, the original row does not', async () => {
    const ev = await plantEvent(1000, true);
    const before = await recompute(businessToday, businessToday);

    const corr = await api('POST', `/ledger/${ev.id}/correct`, { gallons_pumped: 2000 }, officeToken);
    expect(corr.status).toBe(201);
    created.events.push(String(corr.body.event.id));

    const r = await api('GET', `/ledger/report?from=${businessToday}&to=${businessToday}`, undefined, officeToken);
    const after = await recompute(businessToday, businessToday);
    expect(r.body.totals.events).toBe(after.events);      // one head per chain: count unmoved
    expect(Number(r.body.totals.gallons) - Number(before.gallons)).toBeCloseTo(1000, 1);
  });

  it('counts an event with no gallons in the events and never in the gallons', async () => {
    const ev = await plantEvent(1100, true);
    const base = (await recompute(businessToday, businessToday));
    await plantEvent(null, true);

    const r = await api('GET', `/ledger/report?from=${businessToday}&to=${businessToday}`, undefined, officeToken);
    expect(r.body.totals.events).toBe(base.events + 1);
    expect(r.body.totals.events_without_gallons).toBeGreaterThan(0);
    // The no-gallons row must not *look* like a zero in the sum:
    expect(Number(r.body.totals.gallons)).toBeCloseTo(Number(base.gallons), 1);
  });

  it('answers an empty window with zeros, not with an error', async () => {
    const far = '2099-01-01';
    const r = await api('GET', `/ledger/report?from=${far}&to=${far}`, undefined, officeToken);
    expect(r.status).toBe(200);
    expect(r.body.totals.events).toBe(0);
    expect(r.body.months).toEqual([]);
  });

  it('refuses a reversed or malformed window before reading anything', async () => {
    expect((await api('GET', `/ledger/report?from=2024-12-02&to=2024-01-01`, undefined, officeToken)).status).toBe(400);
    expect((await api('GET', `/ledger/report?from=today`, undefined, officeToken)).status).toBe(400);
  });

  it('no pre-computed tally exists to drift', async () => {
    // The P1 guard, in the NF-03 style: not "we deleted tblStateReports" but
    // "nothing in this schema is allowed to be a stored counter table again".
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'septic_app' AND table_type = 'BASE TABLE'
          AND (table_name ILIKE '%report%' OR table_name ILIKE '%tally%'
               OR table_name ILIKE '%wisconsin%' OR table_name ILIKE '%summary%')`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });
});
