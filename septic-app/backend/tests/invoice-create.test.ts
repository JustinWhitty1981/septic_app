import { Client } from 'pg';
import { connect } from './db';

/**
 * T-BIL-20 — creating an invoice (`POST /api/invoices`).
 *
 * The suite walks the four ways a line can be true and the several ways a
 * document can lie, and its centre of gravity is the claim that the money
 * is the database's: a client that posts its own total is answered with the
 * total that is true. The second half is the drain promise of the billing
 * queue — found on the queue before, absent after, and the queue itself
 * never touched by either request.
 */

const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';

const LEAKS = [
  'septic_app', 'legacy.', 'relation "', 'does not exist', 'column "',
  'violates foreign key', 'violates unique constraint', 'duplicate key value',
  'QueryFailedRunner', 'QueryFailedError', 'at Function.', 'invalid input syntax',
  'null value in column', 'for update cannot be used',
];

let db: Client;
let officeToken = '';
let rate = '0';

const emails: string[] = [];
const eventIds: string[] = [];
const invoiceIds: number[] = [];
const payerIds: number[] = [];
const propertyIds: number[] = [];
const itemIds: number[] = [];

const send = async (method: string, path: string, body?: unknown, token?: string) => {
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

const newSite = async (label: string): Promise<number> => {
  const r = await send('POST', '/properties', {
    site_address: `9 ${label} ${RUN} Create Way`, site_city: 'Testford',
    site_state: 'wi', site_zip: '54932', payer_label: `T-BIL-20 ${label} ${RUN}`,
  });
  expect(r.status).toBe(201);
  propertyIds.push(Number(r.body.data.id));
  return Number(r.body.data.id);
};

const newPayer = async (label: string, taxExempt = false): Promise<number> => {
  const r = await send('POST', '/payers', {
    org_name: `Create Payer ${label} ${RUN}`, mailing_address: '1 Desk Rd',
    mailing_city: 'Testford', mailing_state: 'wi', mailing_zip: '54932',
  });
  expect(r.status).toBe(201);
  const id = Number(r.body.data.id);
  payerIds.push(id);
  if (taxExempt) {
    // The API does not expose tax_exempt (BIL: a flag the office sets
    // deliberately, if ever), so the fixture sets it the way an operator
    // with a psql prompt would.
    await db.query(`UPDATE septic_app.payers SET tax_exempt = true WHERE id = $1`, [id]);
  }
  return id;
};

const fileRecord = async (siteId: number): Promise<string> => {
  const [site] = (await db.query(
    `SELECT id FROM septic_app.disposal_sites ORDER BY id LIMIT 1`)).rows;
  const [wt] = (await db.query(
    `SELECT id FROM septic_app.waste_types ORDER BY id LIMIT 1`)).rows;
  const r = await send('POST', '/ledger/events', {
    property_id: siteId, gallons_pumped: 1000,
    waste_type_id: wt.id, disposal_site_id: site.id,
  });
  expect(r.status).toBe(201);
  eventIds.push(String(r.body.data.id));
  return String(r.body.data.id);
};

const onQueue = async (eventId: string): Promise<boolean> => {
  const r = await send('GET', '/ledger/unbilled-events?days=365&limit=500');
  expect(r.status).toBe(200);
  return (r.body.data as any[]).some((x) => x.service_event_id === eventId);
};

const create = (body: unknown) => send('POST', '/invoices', body);

beforeAll(async () => {
  db = await connect();
  rate = (await db.query(
    `SELECT sales_tax_rate::text AS r FROM septic_app.company_settings WHERE id = 1`,
  )).rows[0].r;

  const { hashPassword } = require('../src/utils/password');
  const email = `t-bil20.office.${RUN}@test.invalid`;
  emails.push(email);
  await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Bil20',$1,$2,'office',true)`,
    [email, await hashPassword(PASSWORD)]);
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  officeToken = ((await login.json() as any).token ?? '');

  const item = await db.query(
    `INSERT INTO septic_app.bid_items (name, unit, unit_price, is_active)
     VALUES ($1, 'job', '75.50', true) RETURNING id`,
    [`Sump cleanout ${RUN}`]);
  itemIds.push(Number(item.rows[0].id));
}, 30_000);

afterAll(async () => {
  await db.query('BEGIN');
  await db.query(`SET LOCAL septic.ledger_repair = 'on'`);
  if (invoiceIds.length) {
    await db.query(`DELETE FROM septic_app.invoice_lines WHERE invoice_id = ANY($1::int[])`,
      [invoiceIds]);
    await db.query(`DELETE FROM septic_app.invoices WHERE id = ANY($1::int[])`, [invoiceIds]);
  }
  if (eventIds.length) {
    await db.query(`DELETE FROM septic_app.service_events WHERE id = ANY($1::bigint[])`,
      [eventIds]);
  }
  await db.query('COMMIT');
  if (itemIds.length) {
    await db.query(`DELETE FROM septic_app.bid_items WHERE id = ANY($1::int[])`, [itemIds]);
  }
  for (const pid of propertyIds) {
    await db.query(`DELETE FROM septic_app.property_ownerships WHERE property_id = $1`, [pid]);
  }
  if (propertyIds.length) {
    await db.query(`DELETE FROM septic_app.properties WHERE id = ANY($1::int[])`, [propertyIds]);
  }
  if (payerIds.length) {
    await db.query(`DELETE FROM septic_app.payers WHERE id = ANY($1::int[])`, [payerIds]);
  }
  for (const email of emails) {
    await db.query('DELETE FROM septic_app.users WHERE email = $1', [email]);
  }
  await db?.end();
});

describe('T-BIL-20: creating an invoice', () => {
  it('bills a pump-out and a price-list item at totals the database computed', async () => {
    const site = await newSite('one');
    const payer = await newPayer('one');
    const event = await fileRecord(site);
    const before = await onQueue(event);
    expect(before).toBe(true);

    const r = await create({
      payer_id: payer, property_id: site,
      // The client's arithmetic is a wish, not an input. It is ignored —
      // including these deliberately wrong fields.
      subtotal: '9999.00', total: '9999.00',
      lines: [
        { service_event_id: event, description: `Pump-out ${RUN}`, quantity: '1.5', unit_price: '100' },
        { bid_item_id: itemIds[0], description: `Sump cleanout ${RUN}`, quantity: '1', unit_price: '75.50' },
      ],
    });
    expect(r.status).toBe(201);
    invoiceIds.push(Number(r.body.data.invoice.id));
    const inv = r.body.data.invoice;

    // 1.5 × 100 = 150.00 and 1 × 75.50 — the subtotal is the lines, not the
    // number the browser sent.
    expect(inv.subtotal).toBe('225.50');
    const wantTax = (Math.round(Number(inv.subtotal) * Number(rate) * 100) / 100)
      .toFixed(2);
    expect(inv.tax_amount).toBe(wantTax);
    expect(Number(inv.total))
      .toBeCloseTo(Number(inv.subtotal) + Number(inv.tax_amount), 2);
      expect(inv.status).toBe('open');
      expect(inv.invoice_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // 0035: who created it is read off the login, never a field the body could set.
      const owner = (await db.query(
        `SELECT u.email AS email FROM septic_app.invoices i
           LEFT JOIN septic_app.users u ON u.id = i.created_by WHERE i.id = $1`,
        [inv.id],
      )).rows[0];
      expect(owner.email).toBe(emails[0]);

    // And the drain happened by itself: the queue's condition is the POST's
    // effect, seen twice.
    expect(await onQueue(event)).toBe(false);
    nothingLeaks(r.body);
  });

  it('a payer marked tax-exempt is never taxed, whatever the settings say',
    async () => {
      const site = await newSite('exempt');
      const payer = await newPayer('exempt', true);
      const r = await create({
        payer_id: payer,
        lines: [{
          legacy_product_code: 'PSI', description: `Legacy-style line ${RUN}`,
          quantity: '2', unit_price: '10.25',
        }],
      });
      expect(r.status).toBe(201);
      invoiceIds.push(Number(r.body.data.invoice.id));
      expect(r.body.data.invoice.tax_rate).toBe('0');
      expect(r.body.data.invoice.tax_amount).toBe('0.00');
      expect(r.body.data.invoice.subtotal).toBe('20.50');
    });

  it('a line left taxable and a line taken off tax: the rate lands only on the taxable base',
    async () => {
      const site = await newSite('mixed');
      const payer = await newPayer('mixed');
      const r = await create({
        payer_id: payer, property_id: site,
        lines: [
          // no taxable key at all → defaults true, the way every line was before 0034
          { legacy_product_code: 'TAX1', description: `Taxable ${RUN}`, quantity: '1', unit_price: '100' },
          // an explicit untaxed line is out of the base the rate is measured against
          { legacy_product_code: 'FREE1', description: `Untaxed ${RUN}`, quantity: '1', unit_price: '50', taxable: false },
        ],
      });
      expect(r.status).toBe(201);
      invoiceIds.push(Number(r.body.data.invoice.id));
      const inv = r.body.data.invoice;

      // the subtotal is every line; the tax is the rate over the taxable one only
      expect(inv.subtotal).toBe('150.00');
      const wantTax = (Math.round(100 * Number(rate) * 100) / 100).toFixed(2);
      expect(inv.tax_amount).toBe(wantTax);
      expect(Number(inv.total)).toBeCloseTo(150 + Number(wantTax), 2);

      // the flag is stored, read back line by line
      const detail = await send('GET', `/invoices/${Number(inv.id)}`);
      expect(detail.status).toBe(200);
      const byDesc = new Map<string, unknown>(
        (detail.body.data.lines as any[]).map((x) => [x.description, x.taxable]));
      expect(byDesc.get(`Taxable ${RUN}`)).toBe(true);
      expect(byDesc.get(`Untaxed ${RUN}`)).toBe(false);
      nothingLeaks(r.body);
    });

  it('billing a billed event is refused by naming the invoice that beat you to it',
    async () => {
      const site = await newSite('twice');
      const payer = await newPayer('twice');
      const event = await fileRecord(site);
      const first = await create({
        payer_id: payer,
        lines: [{ service_event_id: event, description: `First claim ${RUN}`, quantity: '1', unit_price: '100' }],
      });
      expect(first.status).toBe(201);
      invoiceIds.push(Number(first.body.data.invoice.id));

      const again = await create({
        payer_id: payer,
        lines: [{ service_event_id: event, description: `Second claim ${RUN}`, quantity: '1', unit_price: '100' }],
      });
      expect(again.status).toBe(409);
      expect(again.body.message).toContain('already billed');
      expect(again.body.message).toContain(String(first.body.data.invoice.id));
      nothingLeaks(again.body);
    });

  it('billing a superseded event names the correction that is now the head',
    async () => {
      const site = await newSite('corrected');
      const payer = await newPayer('corrected');
      const event = await fileRecord(site);
      const [today] = (await db.query(
        `SELECT to_char(business_today(),'YYYY-MM-DD') AS d`)).rows;
      const corr = await db.query(
        `INSERT INTO septic_app.service_events
           (property_id, service_date, status, gallons_pumped, waste_type_id,
            disposal_site_id, source, corrects_event_id)
         SELECT $1, $2::date, 'completed', 1200,
                (SELECT id FROM septic_app.waste_types ORDER BY id LIMIT 1),
                (SELECT id FROM septic_app.disposal_sites ORDER BY id LIMIT 1),
                'app', $3::bigint
         RETURNING id`,
        [site, today.d, event]);
      const head = String(corr.rows[0].id);
      eventIds.push(head);

      const r = await create({
        payer_id: payer,
        lines: [{ service_event_id: event, description: `Old record ${RUN}`, quantity: '1', unit_price: '100' }],
      });
      expect(r.status).toBe(409);
      expect(r.body.message).toContain('corrected');
      expect(r.body.message).toContain(head);
      nothingLeaks(r.body);
    });

  it('refusals name the thing the form got wrong', async () => {
    const payer = await newPayer('validator');

    const empty = await create({ payer_id: payer, lines: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.message).toContain('non-empty');

    const noPayer = await create({ lines: [{ legacy_product_code: 'X', description: 'd', quantity: '1', unit_price: '1' }] });
    expect(noPayer.status).toBe(400);
    expect(noPayer.body.message).toContain('payer_id');

    const ghostPayer = await create({
      payer_id: 999999999,
      lines: [{ legacy_product_code: 'X', description: 'd', quantity: '1', unit_price: '1' }],
    });
    expect(ghostPayer.status).toBe(404);
    expect(ghostPayer.body.message).toContain('No payer has id 999999999');

    const ghostItem = await create({
      payer_id: payer,
      lines: [{ bid_item_id: 999999999, description: 'd', quantity: '1', unit_price: '1' }],
    });
    expect(ghostItem.status).toBe(404);
    expect(ghostItem.body.message).toContain('price-list item');

    const zeroQty = await create({
      payer_id: payer,
      lines: [{ legacy_product_code: 'X', description: 'd', quantity: '0', unit_price: '1' }],
    });
    expect(zeroQty.status).toBe(400);
    expect(zeroQty.body.message).toContain('line 1');

    const doubleRef = await create({
      payer_id: payer,
      lines: [{
        legacy_product_code: 'X', bid_item_id: itemIds[0],
        description: 'd', quantity: '1', unit_price: '1',
      }],
    });
    expect(doubleRef.status).toBe(400);
    expect(doubleRef.body.message).toContain('more than one thing');

    const bare = await create({
      payer_id: payer, lines: [{ description: 'just vibes', quantity: '1', unit_price: '1' }],
    });
    expect(bare.status).toBe(400);
    expect(bare.body.message).toContain('sentence, not a charge');

    const site = await newSite('twice-in-doc');
    const event = await fileRecord(site);
    const sameEventTwice = await create({
      payer_id: payer,
      lines: [
        { service_event_id: event, description: 'a', quantity: '1', unit_price: '1' },
        { service_event_id: event, description: 'b', quantity: '1', unit_price: '2' },
      ],
    });
    expect(sameEventTwice.status).toBe(400);
    expect(sameEventTwice.body.message).toContain('lines 1 and 2');
  });

  it('the queue can be asked one site at a time, and names each site’s current owner',
    async () => {
      const site = await newSite('owned');
      const payer = await newPayer('owner');
      await db.query(
        `INSERT INTO septic_app.property_ownerships
           (payer_id, property_id, is_primary, ownership_start, source)
         VALUES ($1, $2, true, '2026-01-01', 'app')`,
        [payer, site],
      );
      const event = await fileRecord(site);

      const r = await send('GET', `/ledger/unbilled-events?days=365&property_id=${site}`);
      expect(r.status).toBe(200);
      expect(r.body.data).toHaveLength(1);
      expect(r.body.data[0].service_event_id).toBe(event);
      expect(Number(r.body.data[0].owner_payer_id)).toBe(payer);
      // The dialog pre-fills "billed to" with this name — the queue row has
      // to carry it, or the office re-searches a biller the site already
      // names.
      expect(r.body.data[0].owner_payer_name)
        .toContain(`Create Payer owner ${RUN}`);

      const bad = await send('GET', '/ledger/unbilled-events?property_id=nope');
      expect(bad.status).toBe(400);
    });
});
