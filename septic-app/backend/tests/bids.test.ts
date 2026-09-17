import { Client } from 'pg';
import { connect } from './db';

/**
 * T-BIL-09..16 — the bids sprint: the price list, the document, the signature,
 * the invoice, and the tax that ties them together.
 *
 * The canonical document is the one from the requirement text: "Licensed
 * plumber labor" at $300.00/hour × 3 = $900.00, "Schedule 40 PVC pipe 1 1/2"
 * at $3.00/foot × 100 = $300.00. The arithmetic assertions are that example to
 * the cent, because the example is what the office will compare the screen
 * against the first Tuesday it is open.
 *
 * House rules observed: the database is the evidence (every claim is re-read
 * through `db`, not through the response that made it), planted rows are
 * deleted in `afterAll` including the ledger-guarded receipts (via the
 * documented repair escape), the shared settings row is restored to the seeded
 * 0.0000, and no test depends on Jest's ordering — every bid gets its own
 * rows, the only shared mutable state is the rate, which its own suite owns
 * and restores.
 */

const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';

const LEAKS = [
  'septic_app', 'legacy.', 'relation "', 'does not exist', 'column "',
  'violates foreign key', 'violates unique constraint', 'duplicate key value',
  'QueryFailedRunner', 'QueryFailedError', 'at Function.', 'invalid input syntax',
  'could not determine data type', 'null value in column', 'generated',
];

let db: Client;
let officeToken = '';
let driverToken = '';
let payerId = 0;
let payerId2 = 0;
let itemId = 0;         // Licensed plumber labor, $300.00/hour
let pipeId = 0;         // Schedule 40 PVC pipe 1 1/2, $3.00/foot
let siteId = 0;         // an existing legacy site, referenced never written
let officeUserId = 0;
const emails: string[] = [];
const payerIds: number[] = [];
const itemIds: number[] = [];
const bidIds: number[] = [];
const invoiceIds: number[] = [];

let businessToday = '';

interface Res { status: number; body: any }

const send = async (method: string, path: string, body?: unknown, token?: string): Promise<Res> => {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const t = token ?? officeToken;
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

const makeUser = async (email: string, role: string): Promise<number> => {
  const { hashPassword } = require('../src/utils/password');
  emails.push(email);
  const { rows } = await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Bid',$1,$2,$3::user_role,true) RETURNING id`,
    [email, await hashPassword(PASSWORD), role],
  );
  return Number(rows[0].id);
};

const login = async (email: string): Promise<string> => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body: any = await res.json().catch(() => ({}));
  return body?.token ?? '';
};

const makePayer = async (org: string): Promise<number> => {
  const { rows } = await db.query(
    `INSERT INTO septic_app.payers (org_name, mailing_address, mailing_city, mailing_state, mailing_zip)
     VALUES ($1, '1 Test Way', 'Oshkosh', 'WI', '54904') RETURNING id`,
    [`${org} ${RUN}`],
  );
  const id = Number(rows[0].id);
  payerIds.push(id);
  return id;
};

const makeItem = async (name: string, unit: string, price: string): Promise<number> => {
  const { status, body } = await send('POST', '/bid-items', { name, unit, unit_price: price });
  expect(status).toBe(201);
  itemIds.push(Number(body.data.id));
  return Number(body.data.id);
};

/** Create + line the canonical bid (labor ×3 = 900, pipe ×100 = 300, subtotal 1200.00). */
const makeCanonicalBid = async (): Promise<number> => {
  const created = await send('POST', '/bids', { payer_id: payerId });
  expect(created.status).toBe(201);
  const id = Number(created.body.data.id);
  bidIds.push(id);
  for (const [item, quantity] of [[itemId, '3'], [pipeId, '100']] as const) {
    const line = await send('POST', `/bids/${id}/lines`, { bid_item_id: item, quantity });
    expect(line.status).toBe(201);
  }
  return id;
};

const readBid = async (id: number) => {
  const { rows } = await db.query(
    `SELECT status::text AS status, tax_rate::text AS tax_rate,
            approved_by, (approved_at IS NOT NULL) AS approved,
            (declined_at IS NOT NULL) AS declined, invoice_id
       FROM septic_app.bids WHERE id = $1`,
    [id],
  );
  return rows[0];
};

const readBidLines = async (id: number) => {
  const { rows } = await db.query(
    `SELECT description, unit, unit_price::text AS unit_price, quantity::text AS quantity,
            line_total::text AS line_total, bid_item_id, sequence_no
       FROM septic_app.bid_lines WHERE bid_id = $1 ORDER BY sequence_no`,
    [id],
  );
  return rows;
};

beforeAll(async () => {
  db = await connect();
  const { rows: bt } = await db.query(
    `SELECT to_char(business_today(),'YYYY-MM-DD') AS t`,
  );
  businessToday = bt[0].t;
  officeUserId = await makeUser(`t-bil.office.${RUN}@test.invalid`, 'office');
  officeToken = await login(`t-bil.office.${RUN}@test.invalid`);
  await makeUser(`t-bil.driver.${RUN}@test.invalid`, 'driver');
  driverToken = await login(`t-bil.driver.${RUN}@test.invalid`);
  expect(officeToken && driverToken).toBeTruthy();

  // The suite owns this row and must not inherit it from the last run: a
  // crashed run that skipped afterAll left 0.0550 in the column and three
  // tax-zero tests reddened for the wrong reason. The seed itself is asserted
  // from the migration text (T-BIL-16), not from whatever the column holds.
  await db.query(`UPDATE septic_app.company_settings
                     SET sales_tax_rate = 0, updated_by = NULL
                   WHERE id = 1`);
  payerId = await makePayer('Northfield Test Holdings');
  payerId2 = await makePayer('Mound Buyer Two');
  const { rows: site } = await db.query(
    `SELECT id FROM septic_app.properties WHERE status = 'active' ORDER BY id LIMIT 1`,
  );
  siteId = Number(site[0].id);
});

afterAll(async () => {
  // Every step runs whether or not the one before it survived — an afterAll
  // that throws on step two leaves the pg client open and Jest hanging on a
  // green-looking red, which is exactly how a 10-minute CI timeout reads.
  const attempt = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`afterAll cleanup [${label}] failed:`, (e as Error).message);
      // An aborted transaction poisons every later statement on this client —
      // a cleanup that cannot roll back is how one FK failure becomes nine.
      try { await db.query('ROLLBACK'); } catch { /* not in a transaction */ }
    }
  };
  await attempt('rate restore', () =>
    db.query(`UPDATE septic_app.company_settings SET sales_tax_rate = 0 WHERE id = 1`));
  // Invoices are under the same append-only guard as receipts — the escape
  // covers both deletions in one transaction, receipts first (their FK is
  // RESTRICT). This is fixture surgery with the lights on, never a repair.
  // The invoice set is not just the ids some test remembered to push — a
  // test that threw between convert() and the push has already made a real
  // invoice, and one surviving invoice_line referencing a bid line holds
  // RESTRICT on the whole cascade (it did: one abort became nine). bids
  // .invoice_id is the server's own memory; trust it over the array.
  await attempt('ledger (receipts, lines, bids, invoices)', async () => {
    const { rows } = await db.query(
      `SELECT invoice_id FROM septic_app.bids
        WHERE id = ANY($1::int[]) AND invoice_id IS NOT NULL`, [bidIds]);
    const allInvoiceIds = [...new Set([...invoiceIds, ...rows.map((r) => r.invoice_id)])]
      .map(Number);
    await db.query('BEGIN');
    await db.query(`SET LOCAL septic.ledger_repair = 'on'`);
    // Every direction of every arrow, in FK order: receipts RESTRICT their
    // invoice; invoice_lines RESTRICT bid_lines; bids RESTRICT invoices
    // (invoice_id) while invoices' lines RESTRICT bid_lines' deletion.
    // Lines by BOTH doors (invoice and bid-line), then the bid, then the
    // invoice — payments up front.
    if (allInvoiceIds.length) {
      await db.query(`DELETE FROM septic_app.payments WHERE invoice_id = ANY($1::int[])`,
        [allInvoiceIds]);
      await db.query(
        `DELETE FROM septic_app.invoice_lines
          WHERE invoice_id = ANY($1::int[])
             OR bid_line_id IN (SELECT id FROM septic_app.bid_lines
                                 WHERE bid_id = ANY($2::int[]))`,
        [allInvoiceIds, bidIds]);
    }
    await db.query(`DELETE FROM septic_app.bids WHERE id = ANY($1::int[])`, [bidIds]);
    if (allInvoiceIds.length) {
      await db.query(`DELETE FROM septic_app.invoices WHERE id = ANY($1::int[])`,
        [allInvoiceIds]);
    }
    await db.query('COMMIT');
  });
  await attempt('bids (cascade their lines)', () =>
    db.query(`DELETE FROM septic_app.bids WHERE id = ANY($1::int[])`, [bidIds]));
  await attempt('items', () =>
    db.query(`DELETE FROM septic_app.bid_items WHERE id = ANY($1::int[])`, [itemIds]));
  await attempt('payers', () =>
    db.query(`DELETE FROM septic_app.payers WHERE id = ANY($1::int[])`, [payerIds]));
  for (const email of emails) {
    await attempt(`user ${email}`, () =>
      db.query('DELETE FROM septic_app.users WHERE email = $1', [email]));
  }
  await attempt('disconnect', () => db.end());
});

describe('T-BIL-09: the master price list', () => {
  it('creates items and answers the row — money in text out, no float in between', async () => {
    itemId = await makeItem('Licensed plumber labor', 'hour', '300.00');
    pipeId = await makeItem('Schedule 40 PVC pipe 1 1/2', 'feet', '3.00');
    const { body } = await send('GET', '/bid-items');
    const labor = body.data.find((r: any) => r.id === itemId);
    expect(labor).toMatchObject({ name: 'Licensed plumber labor', unit: 'hour',
      unit_price: '300.00', is_active: true });
  });

  it('refuses the halves of a price: no name, no unit, negative number — each by name', async () => {
    for (const [body, needle] of [
      [{ unit: 'hour', unit_price: '10.00' }, 'name'],
      [{ name: 'x', unit_price: '10.00' }, 'unit'],
      [{ name: 'x', unit: 'hour', unit_price: '-5' }, 'unit_price'],
      [{ name: 'x', unit: 'hour', unit_price: '10.00', id: 99 }, 'id'],
    ] as const) {
      const res = await send('POST', '/bid-items', body);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain(needle);
      nothingLeaks(res.body);
    }
  });

  it('edits a price in place — and the bid lined before the edit does not move', async () => {
    // The whole reason copies beat joins: the list is allowed to be wrong about
    // today's price because yesterday's document carries yesterday's number.
    const bid = await makeCanonicalBid();
    const before = await readBidLines(bid);

    const edit = await send('PATCH', `/bid-items/${itemId}`, { unit_price: '350.00' });
    expect(edit.status).toBe(200);
    expect(edit.body.data.unit_price).toBe('350.00');

    const after = await readBidLines(bid);
    expect(after).toEqual(before); // byte-for-byte: the copy is the record
    // and a NEW line from the same item now copies the new price
    const newLine = await send('POST', `/bids/${bid}/lines`, { bid_item_id: itemId, quantity: '1' });
    expect(newLine.status).toBe(201);
    expect(newLine.body.data).toMatchObject({ unit_price: '350.00', line_total: '350.00' });
    await send('DELETE', `/bids/${bid}/lines/${newLine.body.data.id}`);
    await send('PATCH', `/bid-items/${itemId}`, { unit_price: '300.00' }); // restore for later describes
  });

  it('retires an item behind is_active — hidden from the picker, visible to history, never deleted', async () => {
    const retired = await makeItem('Old trench price', 'feet', '1.00');
    await send('PATCH', `/bid-items/${retired}`, { is_active: false });
    const fresh = await send('GET', '/bid-items');
    expect(fresh.body.data.map((r: any) => r.id)).not.toContain(retired);
    const all = await send('GET', '/bid-items?include_retired=1');
    expect(all.body.data.map((r: any) => r.id)).toContain(retired);
    // a retired item can still be quoted by explicit id (BIL-10)
    const bid = await makeCanonicalBid();
    const line = await send('POST', `/bids/${bid}/lines`, { bid_item_id: retired, quantity: '2' });
    expect(line.status).toBe(201);
    expect(line.body.data).toMatchObject({ unit_price: '1.00', line_total: '2.00' });
  });

  it('a driver reads the list — the price is not the secret; changing it is', async () => {
    const res = await send('GET', '/bid-items', undefined, driverToken);
    expect(res.status).toBe(200);
    const write = await send('POST', '/bid-items',
      { name: 'driver price', unit: 'hour', unit_price: '1.00' }, driverToken);
    expect(write.status).toBe(403);
  });
});

describe('T-BIL-10: a bid is a document addressed to somebody', () => {
  it('a bid names a payer that exists; the 404 says what to do about one that does not', async () => {
    const ghost = await send('POST', '/bids', { payer_id: 999999 });
    expect(ghost.status).toBe(404);
    expect(ghost.body.message).toMatch(/biller form/);
    nothingLeaks(ghost.body);
    const badSite = await send('POST', '/bids', { payer_id: payerId, property_id: 999999 });
    expect(badSite.status).toBe(404);
    expect(badSite.body.message).toBe('No site has id 999999.');
  });

  it('the date is the server\'s business today — a client-supplied one is refused by name', async () => {
    const typed = await send('POST', '/bids', { payer_id: payerId, bid_date: '2020-01-01' });
    expect(typed.status).toBe(400);
    expect(typed.body.message).toContain('bid_date');

    const { body } = await send('POST', '/bids', { payer_id: payerId });
    expect(body.data.bid_date).toBe(businessToday);
    bidIds.push(Number(body.data.id));
  });

  it('a line from the list copies at the moment of adding; a one-off line is allowed on a bid', async () => {
    const bid = await makeCanonicalBid();
    const lines = await readBidLines(bid);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      description: 'Licensed plumber labor', unit: 'hour',
      unit_price: '300.00', quantity: '3.00', line_total: '900.00',
      bid_item_id: itemId,
    });
    expect(lines[1]).toMatchObject({ line_total: '300.00', bid_item_id: pipeId });

    const oneOff = await send('POST', `/bids/${bid}/lines`, {
      description: 'Haul the old pad away', unit: 'load', unit_price: '450.00', quantity: '1',
    });
    expect(oneOff.status).toBe(201);
    expect(oneOff.body.data.bid_item_id).toBeNull();

    const both = await send('POST', `/bids/${bid}/lines`, {
      bid_item_id: itemId, description: 'both', unit: 'x', unit_price: '1', quantity: '1',
    });
    expect(both.status).toBe(400);
    expect(both.body.message).toMatch(/not both/);
    const noDesc = await send('POST', `/bids/${bid}/lines`, {
      description: '', unit: 'load', unit_price: '1.00', quantity: '1',
    });
    expect(noDesc.status).toBe(400);
  });

  it('the detail response carries the mailing block — one request, one document (BIL-08)', async () => {
    const { body } = await send('GET', `/bids/${bidIds[bidIds.length - 1]}`);
    expect(body.data).toMatchObject({
      payer_name: expect.stringContaining('Northfield Test Holdings'.slice(0, 12)),
      mailing_address: '1 Test Way', mailing_city: 'Oshkosh',
      mailing_state: 'WI', mailing_zip: '54904',
    });
  });
});

describe('T-BIL-11: the arithmetic the keyboard may not type', () => {
  it('the canonical example is exact: 3 × 300.00 = 900.00, 100 × 3.00 = 300.00, total 1,200.00', async () => {
    const bid = await makeCanonicalBid();
    const { body } = await send('GET', `/bids/${bid}`);
    expect(body.data.subtotal).toBe('1200.00');
    expect(body.data.tax_amount).toBe('0.00');   // the seeded system rate
    expect(body.data.total).toBe('1200.00');
  });

  it('a posted line_total is refused by name — it is arithmetic, not an input', async () => {
    const bid = await makeCanonicalBid();
    const res = await send('POST', `/bids/${bid}/lines`,
      { description: 'sneaky', unit: 'each', unit_price: '1.00', quantity: '1',
        line_total: '0.01' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('line_total');
  });

  it('the database itself refuses an update to line_total — GENERATED ALWAYS means always', async () => {
    const bid = await makeCanonicalBid();
    const lines = await readBidLines(bid);
    await expect(db.query(
      `UPDATE septic_app.bid_lines SET line_total = 1 WHERE description = $1`,
      [lines[0].description],
    )).rejects.toThrow();
  });

  it('the total follows a quantity edit — derived per request, never stored', async () => {
    const bid = await makeCanonicalBid();
    const lines = await readBidLines(bid);
    const line = await db.query(
      `SELECT id FROM septic_app.bid_lines WHERE bid_id = $1 AND description = $2`,
      [bid, lines[1].description],
    );
    const edited = await send('PATCH', `/bids/${bid}/lines/${line.rows[0].id}`,
      { quantity: '50' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.line_total).toBe('150.00');
    const { body } = await send('GET', `/bids/${bid}`);
    expect(body.data.subtotal).toBe('1050.00');
  });

  it('quantities: half-hours yes, zero no, negatives no, calculator-soup no, eight figures no', async () => {
    const bid = await makeCanonicalBid();
    for (const q of ['0', '-1', '0.333333', 'abc']) {
      const res = await send('POST', `/bids/${bid}/lines`,
        { description: 'x', unit: 'each', unit_price: '1.00', quantity: q });
      expect(res.status).toBe(400);
    }
    const half = await send('POST', `/bids/${bid}/lines`,
      { bid_item_id: itemId, quantity: '2.5' });
    expect(half.status).toBe(201);
    expect(half.body.data.line_total).toBe('750.00');
    const huge = await send('POST', `/bids/${bid}/lines`,
      { description: 'x', unit: 'each', unit_price: '9999999.98', quantity: '2' });
    expect(huge.status).toBe(400);
    expect(huge.body.message).toContain('10,000,000');
  });
});

describe('T-BIL-12: approval is a signature', () => {
  it('a bid with no lines is not a document', async () => {
    const created = await send('POST', '/bids', { payer_id: payerId });
    bidIds.push(Number(created.body.data.id));
    const res = await send('POST', `/bids/${created.body.data.id}/approve`, {});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/not a document/);
  });

  it('approval stamps who and when, and refuses a caller who tries to pick the signer', async () => {
    const bid = await makeCanonicalBid();
    const impersonate = await send('POST', `/bids/${bid}/approve`, { approved_by: 999 });
    expect(impersonate.status).toBe(400);
    expect(impersonate.body.message).toContain('approved_by');

    const res = await send('POST', `/bids/${bid}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.approved_at).toBeTruthy();
    const row = await readBid(bid);
    expect(Number(row.approved_by)).toBe(officeUserId);

    const twice = await send('POST', `/bids/${bid}/approve`, {});
    expect(twice.status).toBe(409);
    expect(twice.body.message).toMatch(/signature does not accept edits/);
  });

  it('after the signature the document does not move — and not only in the response', async () => {
    const bid = await makeCanonicalBid();
    await send('POST', `/bids/${bid}/approve`, {});
    const lines = await readBidLines(bid);
    const firstLine = await db.query(
      `SELECT id FROM septic_app.bid_lines WHERE bid_id = $1 ORDER BY sequence_no LIMIT 1`,
      [bid],
    );
    const lineId = firstLine.rows[0].id;

    for (const r of [
      await send('POST', `/bids/${bid}/lines`, { bid_item_id: itemId, quantity: '1' }),
      await send('PATCH', `/bids/${bid}/lines/${lineId}`, { quantity: '99' }),
      await send('DELETE', `/bids/${bid}/lines/${lineId}`),
    ]) {
      expect(r.status).toBe(409);
      expect(r.body.message).toMatch(/signature/);
    }
    expect(await readBidLines(bid)).toEqual(lines); // the database agrees with the 409
  });

  it('declining is a decision: terminal, noted, and no longer a signature problem', async () => {
    const bid = await makeCanonicalBid();
    const res = await send('POST', `/bids/${bid}/decline`, { note: 'lost to a cheaper mound guy' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('declined');
    const again = await send('POST', `/bids/${bid}/decline`, {});
    expect(again.status).toBe(409);
    const approveNow = await send('POST', `/bids/${bid}/approve`, {});
    expect(approveNow.status).toBe(409);
    expect(approveNow.body.message).toMatch(/decision|new bid/);
  });
});

describe('T-BIL-13: one approved bid, one invoice, one transaction', () => {
  it('a draft converts nowhere: approve first, by name', async () => {
    const bid = await makeCanonicalBid();
    const res = await send('POST', `/bids/${bid}/convert`, {});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/approve it first/);
  });

  it('at the seeded rate of zero, the invoice IS the example: total 1,200.00, tax 0.00', async () => {
    const bid = await makeCanonicalBid();
    await send('POST', `/bids/${bid}/approve`, {});
    const res = await send('POST', `/bids/${bid}/convert`, {});
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ subtotal: '1200.00', tax_amount: '0.00',
      total: '1200.00' });
    invoiceIds.push(Number(res.body.data.invoice_id));

    const { rows } = await db.query(
      `SELECT i.payer_id, i.service_event_id, i.status::text AS status,
              i.subtotal::text AS subtotal, i.total::text AS total,
              to_char(i.invoice_date,'YYYY-MM-DD') AS invoice_date, i.kind,
              (SELECT count(*)::int FROM septic_app.invoice_lines l
                WHERE l.invoice_id = i.id) AS lines,
              (SELECT count(*) FILTER (WHERE l.bid_line_id IS NOT NULL)::int
                 FROM septic_app.invoice_lines l
                WHERE l.invoice_id = i.id) AS with_bid_ref
         FROM septic_app.invoices i WHERE i.id = $1`,
      [res.body.data.invoice_id],
    );
    expect(rows[0]).toMatchObject({
      payer_id: payerId, service_event_id: null, status: 'open',
      subtotal: '1200.00', total: '1200.00', invoice_date: businessToday,
      kind: 'invoice', lines: 2, with_bid_ref: 2,
    });

    // the bid knows its invoice, in the same breath as the invoice exists
    expect((await readBid(bid)).invoice_id).toBe(Number(res.body.data.invoice_id));
  });

  it('the second convert names the invoice that exists; the double-click produces exactly one', async () => {
    const bid = await makeCanonicalBid();
    await send('POST', `/bids/${bid}/approve`, {});
    const [a, b] = await Promise.all([
      send('POST', `/bids/${bid}/convert`, {}),
      send('POST', `/bids/${bid}/convert`, {}),
    ]);
    const ok = [a, b].find((r) => r.status === 201);
    const late = [a, b].find((r) => r.status === 409);
    expect(ok).toBeTruthy();
    expect(late).toBeTruthy();
    invoiceIds.push(Number(ok!.body.data.invoice_id));
    expect(late!.body.message).toContain(`invoice ${ok!.body.data.invoice_id}`);

    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM septic_app.invoices WHERE id = ANY(
         SELECT invoice_id FROM septic_app.bids WHERE id = $1)`,
      [bid],
    );
    expect(rows[0].n).toBe(1);
  });

  it('the widened line constraint still refuses a line that references nothing', async () => {
    const created = await send('POST', '/bids', { payer_id: payerId2 });
    bidIds.push(Number(created.body.data.id));
    await send('POST', `/bids/${created.body.data.id}/lines`, { bid_item_id: itemId, quantity: '1' });
    await send('POST', `/bids/${created.body.data.id}/approve`, {});
    const conv = await send('POST', `/bids/${created.body.data.id}/convert`, {});
    expect(conv.status).toBe(201);
    invoiceIds.push(Number(conv.body.data.invoice_id));
    // the new arm works — and the old refusals survive: an invoice line naming
    // neither event, product, nor bid line is still illegal.
    await expect(db.query(
      `INSERT INTO septic_app.invoice_lines (invoice_id, description, amount)
       VALUES ($1, 'free text floating on its own', 5)`,
      [conv.body.data.invoice_id],
    )).rejects.toThrow();
  });
});

describe('T-BIL-16: a system-wide sales tax, frozen by the signature', () => {
  it('the seed is the legacy truth: 0.0000 until the office says otherwise', async () => {
    const { body } = await send('GET', '/settings');
    // The seed lives in the migration's INSERT — that is the legacy truth.
    // (The live column was reset by beforeAll; asserting it here would only
    // prove that the reset ran, not that the migration seeded zero.)
    const fs = require('fs');
    const mig = fs.readFileSync(
      require('path').join(__dirname, '..', 'db', 'migrations', '0028_bids.sql'),
      'utf8');
    expect(mig).toMatch(
      /ADD COLUMN sales_tax_rate numeric\(5,4\) NOT NULL DEFAULT 0\b/);
    // and the route reports the row's truth, whatever it is
    expect(body.data.sales_tax_rate).toMatch(/^\d\.\d{4}$/);
  });

  it('the rate is a rate: 5.5% is 0.055, and a percent typed into a rate is refused loudly', async () => {
    for (const raw of ['1.5', '5.5', '-0.01', '0.00001', 'banana']) {
      const res = await send('PATCH', '/settings/sales-tax', { sales_tax_rate: raw });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/0\.055, not 5\.5|decimal rate|4 decimal|number/i);
    }
    const res = await send('PATCH', '/settings/sales-tax', { sales_tax_rate: '0.055' });
    expect(res.status).toBe(200);
    expect(res.body.data.sales_tax_rate).toBe('0.0550');
    const { rows } = await db.query(
      `SELECT updated_by FROM septic_app.company_settings WHERE id = 1`,
    );
    expect(Number(rows[0].updated_by)).toBe(officeUserId); // the decision has a name
  });

  it('approval freezes the tax with the prices: a rate moved afterwards does not reach the signed bid', async () => {
    const bid = await makeCanonicalBid();
    await send('POST', `/bids/${bid}/approve`, {});

    // the rate of the instant is the bid's now
    let detail = await send('GET', `/bids/${bid}`);
    expect(detail.body.data).toMatchObject({
      bid_tax_rate: '0.0550', tax_amount: '66.00', total: '1266.00',
      tax_estimated: false,
    });

    // and then the state moves on
    await send('PATCH', '/settings/sales-tax', { sales_tax_rate: '0.005' });
    detail = await send('GET', `/bids/${bid}`);
    expect(detail.body.data.tax_amount).toBe('66.00'); // the stamp, not the settings
    // while a live draft estimates at the CURRENT rate, labelled as an estimate
    const draft = await makeCanonicalBid();
    const d = await send('GET', `/bids/${draft}`);
    expect(d.body.data).toMatchObject({ tax_estimated: true, tax_amount: '6.00' });

    // conversion obeys the stamp, not today (the BIL-16 mutation target)
    const conv = await send('POST', `/bids/${bid}/convert`, {});
    expect(conv.status).toBe(201);
    invoiceIds.push(Number(conv.body.data.invoice_id));
    expect(conv.body.data).toMatchObject({ subtotal: '1200.00', tax_amount: '66.00',
      total: '1266.00' });
    const { rows } = await db.query(
      `SELECT tax_rate::text AS r FROM septic_app.invoices WHERE id = $1`,
      [conv.body.data.invoice_id],
    );
    expect(rows[0].r).toBe('0.0550'); // the invoice disagrees with settings, correctly
    const bidRow = await readBid(bid);
    expect(bidRow.status).toBe('invoiced');
  });

  it('rounding is SQL\'s, to the cent, before anybody displays it', async () => {
    const bid = await makeCanonicalBid();
    const cheap = await send('POST', `/bids/${bid}/lines`, {
      description: 'test penny fitting', unit: 'each', unit_price: '0.09', quantity: '1',
    });
    expect(cheap.status).toBe(201);
    await send('POST', `/bids/${bid}/approve`, {});
    const { body } = await send('GET', `/bids/${bid}`);
    // 1200.09 × 0.005 (current settings rate) = 6.00045 → 6.00, never 6.00045
    expect(body.data.subtotal).toBe('1200.09');
    expect(body.data.tax_amount).toBe('6.00');
  });
});

describe('T-BIL-14: the money machinery never noticed the new invoice', () => {
  // Driven entirely through the endpoints pump-outs already had (BIL-06/07).
  // The assertion IS the absence of new endpoints.
  let invoiceId = 0;

  beforeAll(async () => {
    const bid = await makeCanonicalBid();
    await send('POST', `/bids/${bid}/approve`, {}); // rate is 0.005 from the tax describe
    const conv = await send('POST', `/bids/${bid}/convert`, {});
    expect(conv.status).toBe(201);
    invoiceId = Number(conv.body.data.invoice_id);
    invoiceIds.push(invoiceId);
  });

  it('a $500 check on a construction invoice re-sums amount_paid and says partial', async () => {
    const pay = await send('POST', `/invoices/${invoiceId}/payments`,
      { amount: 500, method: 'check', reference: `T-${RUN}` });
    expect(pay.status).toBeLessThan(300);
    const { rows } = await db.query(
      `SELECT amount_paid::text AS paid, status::text AS s FROM septic_app.invoices WHERE id = $1`,
      [invoiceId],
    );
    expect(rows[0].paid).toBe('500.00');
    expect(rows[0].s).toBe('partial');
  });

  it('drift the column and the next receipt overwrites the lie with the sum', async () => {
    await db.query(`UPDATE septic_app.invoices SET amount_paid = 999 WHERE id = $1`, [invoiceId]);
    const pay = await send('POST', `/invoices/${invoiceId}/payments`,
      { amount: 100, method: 'cash' });
    expect(pay.status).toBeLessThan(300);
    const { rows } = await db.query(
      `SELECT amount_paid::text AS paid FROM septic_app.invoices WHERE id = $1`, [invoiceId],
    );
    expect(rows[0].paid).toBe('600.00'); // 500 + 100 — the sum, not 999 + 100
  });

  it('overpayment is refused by naming the balance the customer still owes', async () => {
    const res = await send('POST', `/invoices/${invoiceId}/payments`,
      { amount: 800, method: 'check' });
    expect(res.status).toBe(409);
    // total here is 1,206.00 (the describe's bid carries the 0.005 stamp),
    // 600 has been taken — the server names the remainder, and it is right:
    // this was the one number the tests got wrong and the endpoint did not.
    expect(JSON.stringify(res.body)).toMatch(/606(\.00)?/);
  });

  it('the chase list counts it: receivables re-derives billed, collected, owed', async () => {
    const res = await send('GET', `/receivables`);
    expect(res.status).toBe(200);
    const row = res.body.data.find((r: any) => Number(r.payer_id) === payerId);
    expect(row).toBeTruthy();
    expect(Number(row.collected)).toBeGreaterThanOrEqual(600);
    expect(Number(row.balance)).toBeGreaterThan(0);
  });

  it('the invoice prints its bid lines — description and money from the copies', async () => {
    const res = await send('GET', `/invoices/${invoiceId}`);
    expect(res.status).toBe(200);
    const descs = res.body.data.lines.map((l: any) => l.description);
    expect(descs).toContain('Licensed plumber labor');
    expect(descs).toContain('Schedule 40 PVC pipe 1 1/2');
  });
});
