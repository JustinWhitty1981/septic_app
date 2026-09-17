import { Client } from 'pg';
import { createHash } from 'crypto';
import { connect } from './db';

/**
 * BIL-06 / BIL-07 — receipts as rows, balances as arithmetic.
 *
 * The requirement arrived as a sentence a person would say on the phone:
 * "Jane Smith has an open invoice for $335, they've paid $150, they still owe
 * $185." That sentence has four facts in it — an invoice, a payment, a
 * balance, and the fact that the balance is *derived* — and this suite walks
 * it exactly as spoken, then attacks the two ways it can rot: an
 * `amount_paid` column that drifts from the receipts behind it (so the
 * endpoint re-sums instead of incrementing, and a test proves the re-sum),
 * and a stored balance that lies (so the receivables view recomputes, and a
 * test proves *that* against an independent SQL re-derivation).
 */
const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Receivable1-Passw0rd!';

let db: Client;
let officeToken = '';
let officeId = 0;
const created = {
  invoiceIds: [] as number[], payerIds: [] as number[],
  userIds: [] as number[], emailList: [] as string[],
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

/** Plant an invoice the way the office would not: straight into the table. */
const plantInvoice = async (payerId: number, total: string, status = 'open') => {
  const { rows } = await db.query(
    `INSERT INTO septic_app.invoices (payer_id, invoice_date, subtotal, tax_rate,
        tax_amount, total, amount_paid, status)
     VALUES ($1, CURRENT_DATE, $2::numeric, 0, 0, $2::numeric, 0, $3::invoice_status)
     RETURNING id`, [payerId, total, status],
  );
  const id = Number(rows[0].id);
  created.invoiceIds.push(id);
  return id;
};

const plantPayer = async (name: string) => {
  const { rows } = await db.query(
    `INSERT INTO septic_app.payers (org_name) VALUES ($1) RETURNING id`,
    [`${name} ${RUN}`],
  );
  const id = Number(rows[0].id);
  created.payerIds.push(id);
  return id;
};

const invoiceRow = async (id: number) => (await db.query(
  `SELECT status::text AS status, amount_paid, total FROM septic_app.invoices WHERE id = $1`,
  [id],
)).rows[0];

beforeAll(async () => {
  db = await connect();
  const { hashPassword } = require('../src/utils/password');
  const email = `t-receivable.office.${RUN}@test.invalid`;
  const { rows } = await db.query(
    `INSERT INTO septic_app.users (first_name,last_name,email,password_hash,role,is_active)
     VALUES ('T','Receivable',$1,$2,'office',true) RETURNING id`,
    [email, await hashPassword(PASSWORD)]);
  officeId = Number(rows[0].id);
  created.userIds.push(officeId);
  created.emailList.push(email);
  officeToken = (await api('POST', '/auth/login', { email, password: PASSWORD })).body.token;
});

afterAll(async () => {
  // Payments are append-only; teardown asks the ledger-repair GUC, named out
  // loud, exactly the way the ETL reset does.
  await db.query('BEGIN');
  await db.query(`SET LOCAL septic.ledger_repair = 'on'`);
  if (created.invoiceIds.length) {
    await db.query(`DELETE FROM septic_app.payments WHERE invoice_id = ANY($1::int[])`,
      [created.invoiceIds]);
    await db.query(`DELETE FROM septic_app.invoice_lines WHERE invoice_id = ANY($1::int[])`,
      [created.invoiceIds]);
    await db.query(`DELETE FROM septic_app.invoices WHERE id = ANY($1::int[])`,
      [created.invoiceIds]);
  }
  if (created.payerIds.length) {
    await db.query(`DELETE FROM septic_app.property_ownerships WHERE payer_id = ANY($1::int[])`,
      [created.payerIds]);
    await db.query(`DELETE FROM septic_app.payers WHERE id = ANY($1::int[])`,
      [created.payerIds]);
  }
  await db.query('COMMIT');
  if (created.userIds.length) {
    await db.query('DELETE FROM septic_app.users WHERE id = ANY($1::int[])', [created.userIds]);
  }
  await db?.end();
});

describe('BIL-06: the sentence, end to end', () => {
  let payerId = 0;
  let invoiceId = 0;

  beforeAll(async () => {
    payerId = await plantPayer('Jane Smith');
    invoiceId = await plantInvoice(payerId, '335.00');
  });

  it('a $150 payment against $335 leaves a $185 balance and a "partial" word', async () => {
    const r = await api('POST', `/invoices/${invoiceId}/payments`,
      { amount: 150, method: 'check', reference: '1042', note: 'mailed check' }, officeToken);
    expect(r.status).toBe(201);
    expect(Number(r.body.invoice.balance)).toBeCloseTo(185, 2);
    expect(r.body.invoice.status).toBe('partial');

    const row = await invoiceRow(invoiceId);
    expect(row.status).toBe('partial');
    expect(Number(row.amount_paid)).toBeCloseTo(150, 2);

    // The receipt row says who, how, and with what — the header number alone
    // could not answer the phone call that started this feature.
    const detail = await api('GET', `/invoices/${invoiceId}`, undefined, officeToken);
    expect(detail.body.data.payments).toHaveLength(1);
    const p = detail.body.data.payments[0];
    expect(p.method).toBe('check');
    expect(p.reference).toBe('1042');
    expect(p.received_by).toContain('Receivable'); // the office login took it
    expect(new Date(p.paid_at)).toBeInstanceOf(Date);
  });

  it('the balance closes to zero and the status closes to paid', async () => {
    const r = await api('POST', `/invoices/${invoiceId}/payments`,
      { amount: 185 }, officeToken);
    expect(r.status).toBe(201);
    expect(Number(r.body.invoice.balance)).toBeCloseTo(0, 2);
    expect(r.body.invoice.status).toBe('paid');
    expect((await invoiceRow(invoiceId)).status).toBe('paid');
  });

  it('recomputes from the receipts, never increments them', async () => {
    const inv = await plantInvoice(payerId, '200.00');
    // Drift the column on purpose — 120 against receipts of 0, still inside
    // the paid-within-total CHECK — the failure mode this design refuses.
    await db.query(`UPDATE septic_app.invoices SET amount_paid = 120 WHERE id = $1`, [inv]);
    const r = await api('POST', `/invoices/${inv}/payments`, { amount: 50 }, officeToken);
    expect(r.status).toBe(201);
    // 120 + 50 is the increment's answer; 50 is the re-sum's, and it is the
    // one that agrees with the receipts.
    expect(Number(r.body.invoice.amount_paid)).toBeCloseTo(50, 2);
    expect(Number(r.body.invoice.balance)).toBeCloseTo(150, 2);
  });

  it('refuses an overpayment by name of the balance', async () => {
    const inv = await plantInvoice(payerId, '100.00');
    const r = await api('POST', `/invoices/${inv}/payments`, { amount: 150 }, officeToken);
    expect(r.status).toBe(409);
    expect(Number(r.body.balance)).toBeCloseTo(100, 2);
    expect(String(r.body.error)).toMatch(/exceeds the balance of 100.00/);
    expect(Number((await invoiceRow(inv)).amount_paid)).toBe(0); // nothing half-happened
  });

  it('a void invoice is not collectible', async () => {
    const inv = await plantInvoice(payerId, '50.00', 'void');
    const r = await api('POST', `/invoices/${inv}/payments`, { amount: 10 }, officeToken);
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/void/i);
  });

  it('a replayed receipt (same client_uuid) is one receipt', async () => {
    const inv = await plantInvoice(payerId, '120.00');
    const h = createHash('md5').update('payment-replay' + RUN).digest('hex');
    const body = {
      amount: 20,
      client_uuid: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`,
    };
    const a = await api('POST', `/invoices/${inv}/payments`, body, officeToken);
    expect(a.status).toBe(201);
    const b = await api('POST', `/invoices/${inv}/payments`, body, officeToken);
    expect(b.status).toBe(200);
    expect(b.body.replay).toBe(true);
    expect(Number(b.body.payment.id)).toBe(Number(a.body.payment.id));
    const paid = (await invoiceRow(inv)).amount_paid;
    expect(Number(paid)).toBeCloseTo(20, 2); // not 40
  });

  it('rejects nonsense the endpoint could have quietly accepted', async () => {
    const inv = await plantInvoice(payerId, '100.00');
    expect((await api('POST', `/invoices/${inv}/payments`, { amount: 0 }, officeToken)).status).toBe(400);
    expect((await api('POST', `/invoices/${inv}/payments`, { amount: -25 }, officeToken)).status).toBe(400);
    expect((await api('POST', `/invoices/${inv}/payments`, { amount: 10.005 }, officeToken)).status).toBe(400);
    expect((await api('POST', `/invoices/${inv}/payments`,
      { amount: 10, method: 'bitcoin' }, officeToken)).status).toBe(400);
    expect((await db.query(
      `SELECT count(*)::int AS n FROM septic_app.payments WHERE invoice_id = $1`, [inv],
    )).rows[0].n).toBe(0);
  });

  it('the receipts themselves are append-only, at the database', async () => {
    // The endpoint exposes no edit; the table must be the guarantee anyway,
    // because the psql session with a fix-up script is the reviewer nobody
    // scheduled.
    await expect(db.query(
      `UPDATE septic_app.payments SET amount = 1 WHERE invoice_id = $1`, [invoiceId],
    )).rejects.toThrow(/append-only|42501|insufficient_privilege/i);
    await expect(db.query(
      `DELETE FROM septic_app.payments WHERE invoice_id = $1`, [invoiceId],
    )).rejects.toThrow(/append-only|42501|insufficient_privilege/i);
  });
});

describe('BIL-07: receivables is computed, never stored', () => {
  it('the spoken sentence appears in the list, derived', async () => {
    const payer = await plantPayer('Arlene Receivable');
    const inv = await plantInvoice(payer, '335.00');
    await api('POST', `/invoices/${inv}/payments`, { amount: 150 }, officeToken);

    const r = await api('GET', `/receivables?q=${encodeURIComponent(RUN)}`, undefined, officeToken);
    expect(r.status).toBe(200);
    const me = r.body.data.find((x: any) => x.payer_name.includes('Arlene'));
    expect(Number(me.billed)).toBeCloseTo(335, 2);
    expect(Number(me.collected)).toBeCloseTo(150, 2);
    expect(Number(me.balance)).toBeCloseTo(185, 2);
    expect(me.open_invoices).toBe(1);

    // And independently: the same query the view is built from, written out
    // again. Two derivations agreeing is a fact; one agreeing with itself is a
    // tautology with a schema behind it.
    const [again] = (await db.query(
      `SELECT sum(i.total) FILTER (WHERE i.status::text <> 'void') AS billed,
              coalesce((SELECT sum(p.amount) FROM septic_app.payments p
                         JOIN septic_app.invoices i2 ON i2.id = p.invoice_id
                        WHERE i2.payer_id = $1), 0) AS collected
         FROM septic_app.invoices i WHERE i.payer_id = $1`, [payer],
    )).rows;
    expect(Number(again.billed) - Number(again.collected)).toBeCloseTo(185, 2);
  });

  it('a fully paid payer is absent — balance > 0 is the definition', async () => {
    const payer = await plantPayer('Solved Steve');
    const inv = await plantInvoice(payer, '60.00');
    await api('POST', `/invoices/${inv}/payments`, { amount: 60 }, officeToken);
    const r = await api('GET', `/receivables?q=${encodeURIComponent(RUN)}`, undefined, officeToken);
    expect(r.body.data.find((x: any) => x.payer_name.includes('Solved'))).toBeUndefined();
  });

  it('a credit (adjustment invoice, BIL-05) nets against the balance', async () => {
    const payer = await plantPayer('Netted Nancy');
    const inv = await plantInvoice(payer, '335.00');
    await api('POST', `/invoices/${inv}/payments`, { amount: 0.01 }, officeToken); // keep it partial-visible
    const adj = (await db.query(
      `INSERT INTO septic_app.invoices (payer_id, invoice_date, subtotal, tax_rate,
          tax_amount, total, amount_paid, status, kind, adjusts_invoice_id, adjust_reason)
       VALUES ($1, CURRENT_DATE, -100, 0, 0, -100, 0, 'paid', 'adjustment', $2,
               'netted against the balance for the demo')
       RETURNING id`, [payer, inv],
    )).rows[0];
    created.invoiceIds.push(Number(adj.id));

    const r = await api('GET', `/receivables?q=${encodeURIComponent(RUN)}`, undefined, officeToken);
    const me = r.body.data.find((x: any) => x.payer_name.includes('Nancy'));
    expect(Number(me.balance)).toBeCloseTo(234.99, 2); // billed 335 - 100 (credit) less 0.01 collected
  });

  it('a void invoice leaves the billed side; its orphaned payment shows up as a credit balance', async () => {
    const payer = await plantPayer('Voided Vera');
    const inv = await plantInvoice(payer, '80.00');
    await api('POST', `/invoices/${inv}/payments`, { amount: 80 }, officeToken);
    // Paying an invoice then voiding it: the money stays, the debt story ends.
    // Billed drops the invoice, collected keeps the payment, the balance goes
    // negative — and the meta count says one such person exists, because
    // silence about owed-money-to-customers is how offices get surprised.
    await db.query(`UPDATE septic_app.invoices SET status='void' WHERE id=$1`, [inv]);

    const r = await api('GET', `/receivables?q=${encodeURIComponent(RUN)}`, undefined, officeToken);
    expect(r.body.data.find((x: any) => x.payer_name.includes('Vera'))).toBeUndefined();
    expect(r.body.meta.credit_balances).toBeGreaterThanOrEqual(1);
  });

  it('lists biggest-first and the header totals add up', async () => {
    const r = await api('GET', '/receivables', undefined, officeToken);
    expect(r.status).toBe(200);
    const balances = r.body.data.map((x: any) => Number(x.balance));
    expect(balances).toEqual([...balances].sort((a, b) => b - a));
    const sum = balances.reduce((a, b) => a + b, 0);
    expect(Number(r.body.meta.total_receivable)).toBeCloseTo(sum, 2);
  });
});
