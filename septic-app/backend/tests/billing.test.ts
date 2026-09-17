import { Client } from 'pg';
import { connect } from './db';

/**
 * BIL-01 / BIL-05 — the invoice book after corrections became rows.
 *
 * BIL-03 measured the disease: 3,120 line items whose headers never arrived,
 * the signature of an Access form that committed lines while a human went to
 * fetch something. Two causes are possible and both are asserted against here:
 *
 *   - a line that is only a sentence (BIL-01) — nothing to point the charge at,
 *     nothing to reconcile against;
 *   - no way to correct an invoice (BIL-05) — so people start new documents and
 *     abandon the old.
 *
 * The fix is one rule twice: originals are never rewritten, and every new row
 * answers to something real.
 */
const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Correc7-Passw0rd!';

let db: Client;
let officeToken = '';
const created = { invoices: [] as number[], emails: [] as string[] };

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

/**
 * A fresh invoice to stand in for "the original": a copy of a real legacy
 * header with no lines, created by this run and deleted by this run. The legacy
 * book itself is never the target of a destructive test — corrupting imported
 * history to prove history is protected would be the irony the next reader
 * deserves.
 */
let originalId = 0;

/** A fresh unadjusted original, for cases that need a chain with no head yet. */
const newOriginal = async (): Promise<number> => {
  const src = (await db.query(
    `SELECT payer_id, property_id, invoice_date FROM septic_app.invoices
      WHERE legacy_invoice_no IS NOT NULL ORDER BY id DESC LIMIT 1`,
  )).rows[0];
  const ins = await db.query(
    `INSERT INTO septic_app.invoices (payer_id, property_id, invoice_date,
                                      subtotal, total, amount_paid, status)
     VALUES ($1, $2, $3, 250.00, 250.00, 0, 'open') RETURNING id`,
    [src.payer_id, src.property_id, src.invoice_date],
  );
  const id = Number(ins.rows[0].id);
  created.invoices.push(id);
  return id;
};

const cleanupInvoices = async () => {
  if (!created.invoices.length) return;
  await db.query('BEGIN');
  await db.query(`SET LOCAL septic.ledger_repair = 'on'`);
  // A test that records a payment (the paid-to-zero reconciliation) leaves a receipt
  // row; the book keeps payments under invoices with a RESTRICT key, so the receipts
  // have to go before the documents they point at or the sweep trips the FK.
  await db.query(`DELETE FROM septic_app.payments WHERE invoice_id = ANY($1::int[])`, [created.invoices]);
  await db.query(`DELETE FROM septic_app.invoice_lines WHERE invoice_id = ANY($1::int[])`, [created.invoices]);
  await db.query(`DELETE FROM septic_app.invoices WHERE id = ANY($1::int[])`, [created.invoices]);
  await db.query('COMMIT');
  created.invoices.length = 0;
};

beforeAll(async () => {
  db = await connect();
  const { hashPassword } = require('../src/utils/password');
  const email = `t-bill.${RUN}@test.invalid`;
  await db.query(
    `INSERT INTO septic_app.users
       (first_name, last_name, email, password_hash, role, is_active)
     VALUES ('T','Billing',$1,$2,'office',true)`,
    [email, await hashPassword(PASSWORD)],
  );
  created.emails.push(email);
  officeToken = (await api('POST', '/auth/login', { email, password: PASSWORD })).body.token;

  const src = (await db.query(
    `SELECT payer_id, property_id, invoice_date FROM septic_app.invoices
      WHERE legacy_invoice_no IS NOT NULL ORDER BY id DESC LIMIT 1`,
  )).rows[0];
  const ins = await db.query(
    `INSERT INTO septic_app.invoices (legacy_invoice_no, payer_id, property_id, invoice_date,
                                      subtotal, total, amount_paid, status)
     VALUES (NULL, $1, $2, $3, 250.00, 250.00, 0, 'open') RETURNING id`,
    [src.payer_id, src.property_id, src.invoice_date],
  );
  originalId = Number(ins.rows[0].id);
  created.invoices.push(originalId);
});

afterAll(async () => {
  await cleanupInvoices();
  if (created.emails.length) {
    await db.query('DELETE FROM septic_app.users WHERE email = ANY($1)', [created.emails]);
  }
  await db?.end();
});

describe('BIL-01: a line item answers to a thing', () => {
  it('refuses a description-only line, by constraint name', async () => {
    await expect(db.query(
      `INSERT INTO septic_app.invoice_lines (invoice_id, description, quantity, unit_price, amount)
       VALUES ($1, 'pump out', 1, 250, 250)`,
      [originalId],
    )).rejects.toThrow(/chk_line_reference/);
  });

  it('accepts a product-referenced line and an event-referenced line', async () => {
    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO septic_app.invoice_lines
           (invoice_id, legacy_product_code, description, quantity, unit_price, amount)
         VALUES ($1, 'SVC-STD', 'standard pump-out', 1, 250, 250)`,
        [originalId],
      );
      await db.query(
        `INSERT INTO septic_app.invoice_lines
           (invoice_id, service_event_id, quantity, unit_price, amount)
         VALUES ($1, (SELECT min(id) FROM septic_app.service_events), 1, 45, 45)`,
        [originalId],
      );
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('the adjust endpoint enforces the same rule at the boundary, in words', async () => {
    const r = await api('POST', `/invoices/${originalId}/adjust`, {
      lines: [{ description: 'oops', quantity: 1, unit_price: -50 }],
    }, officeToken);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/service_event_id|legacy_product_code/);
    // No half-written adjustment survives the refusal.
    const { rows } = await db.query(
      `SELECT count(*)::int n FROM septic_app.invoices WHERE adjusts_invoice_id = $1`, [originalId],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('BIL-05: an adjustment is a new invoice that names the old one', () => {
  it('creates the adjustment and leaves the original byte-identical', async () => {
    const before = (await db.query(
      `SELECT subtotal, total, amount_paid, status::text AS status, invoice_date,
              tax_rate, tax_amount, payer_id, property_id, kind
         FROM septic_app.invoices WHERE id = $1`, [originalId],
    )).rows[0];

    const r = await api('POST', `/invoices/${originalId}/adjust`, {
      lines: [
        { legacy_product_code: 'SVC-STD', description: 'billed at wrong rate', quantity: -1, unit_price: 250 },
        { legacy_product_code: 'SVC-CORR', quantity: 1, unit_price: 200 },
      ],
      reason: 'billed at the wrong rate; two pumps not one',
    }, officeToken);
    expect(r.status).toBe(201);
    created.invoices.push(Number(r.body.invoice.id));

    expect(r.body.invoice.kind).toBe('adjustment');
    expect(Number(r.body.invoice.adjusts_invoice_id)).toBe(originalId);
    // -250 + 200 = -50: an honest negative total, which 0009 used to forbid.
    expect(Number(r.body.invoice.total)).toBeCloseTo(-50, 2);

    const after = (await db.query(
      `SELECT subtotal, total, amount_paid, status::text AS status, invoice_date,
              tax_rate, tax_amount, payer_id, property_id, kind
         FROM septic_app.invoices WHERE id = $1`, [originalId],
    )).rows[0];
    expect(after).toEqual(before); // the original was never touched

    const lines = (await db.query(
      `SELECT quantity, unit_price, amount FROM septic_app.invoice_lines
        WHERE invoice_id = $1 ORDER BY id`, [r.body.invoice.id],
    )).rows;
    expect(lines.length).toBe(2);
    expect(Number(lines[0].amount)).toBeCloseTo(-250, 2);
  });

  it('the original refuses money UPDATEs directly in the table, too', async () => {
    await expect(db.query(
      `UPDATE septic_app.invoices SET total = 0 WHERE id = $1`, [originalId],
    )).rejects.toThrow(/append-only/i);
  });

  it('payment bookkeeping still moves — the guard freezes the sale, not the ledger-of-payments', async () => {
    await db.query(
      `UPDATE septic_app.invoices SET amount_paid = 100.00, status = 'open' WHERE id = $1`,
      [originalId],
    );
    const paid = (await db.query(
      `SELECT amount_paid FROM septic_app.invoices WHERE id = $1`, [originalId],
    )).rows[0];
    expect(Number(paid.amount_paid)).toBeCloseTo(100, 2);
  });

  it('refuses a second adjustment of an already-adjusted invoice — one head per document', async () => {
    const original = await newOriginal();
    const first = await api('POST', `/invoices/${original}/adjust`, {
      lines: [{ legacy_product_code: 'SVC-STD', quantity: -1, unit_price: 10 }],
      reason: 'first correction — reversed a double pump',
    }, officeToken);
    expect(first.status).toBe(201);
    created.invoices.push(Number(first.body.invoice.id));

    const second = await api('POST', `/invoices/${original}/adjust`, {
      lines: [{ legacy_product_code: 'SVC-STD', quantity: 1, unit_price: 10 }],
      reason: 'second correction attempt against the same original',
    }, officeToken);
    expect(second.status).toBe(409);
    expect(second.body.current_head).toBe(Number(first.body.invoice.id));

    // The head of the chain is adjustable; chains grow forward.
    const onHead = await api('POST', `/invoices/${first.body.invoice.id}/adjust`, {
      lines: [{ legacy_product_code: 'SVC-STD', quantity: -1, unit_price: 10 }],
      reason: 'forward correction taken on the current head',
    }, officeToken);
    expect(onHead.status).toBe(201);
    created.invoices.push(Number(onHead.body.invoice.id));
  });

  it('an adjustment records why and who; the history is readable; a blank reason does not file',
    async () => {
      const original = await newOriginal();
      const r = await api('POST', `/invoices/${original}/adjust`, {
        lines: [{ legacy_product_code: 'SVC-STD', quantity: -1, unit_price: 10 }],
        reason: 'customer said the tank was pumped twice',
      }, officeToken);
      expect(r.status).toBe(201);
      const adjustmentId = Number(r.body.invoice.id);
      created.invoices.push(adjustmentId);

      // who and why are on the row; who came from the token, never the body.
      const [adj] = (await db.query(
        `SELECT kind, adjust_reason, created_by FROM septic_app.invoices WHERE id = $1`,
        [adjustmentId],
      )).rows;
      expect(adj.kind).toBe('adjustment');
      expect(adj.adjust_reason).toBe('customer said the tank was pumped twice');
      const officeId = Number((await db.query(
        `SELECT id FROM septic_app.users WHERE email = $1`, [created.emails[0]],
      )).rows[0].id);
      expect(Number(adj.created_by)).toBe(officeId);

      // the complaint answer: open the original and read the whole chain back.
      const detail = await api('GET', `/invoices/${original}`, undefined, officeToken);
      expect(detail.status).toBe(200);
      const hist = detail.body.data.history as any[];
      expect(hist.map((h) => h.id)).toEqual(expect.arrayContaining([original, adjustmentId]));
      const entry = hist.find((h) => h.id === adjustmentId);
      expect(entry.adjust_reason).toBe('customer said the tank was pumped twice');
      expect(entry.created_by_name).toMatch(/Billing/i);

      // a correction that cannot explain itself does not file — the record is the point.
      const blank = await api('POST', `/invoices/${await newOriginal()}/adjust`, {
        lines: [{ legacy_product_code: 'SVC-STD', quantity: -1, unit_price: 10 }],
        reason: '   ',
      }, officeToken);
      expect(blank.status).toBe(400);
      expect(blank.body.error).toMatch(/say why/i);
    });

  it('adjusting nothing, or a ghost, is answered before the book is opened', async () => {
    expect((await api('POST', `/invoices/${originalId}/adjust`, { lines: [] }, officeToken)).status).toBe(400);
    expect((await api('POST', '/invoices/999999999/adjust', {
      lines: [{ legacy_product_code: 'X', quantity: 1, unit_price: 1 }],
      reason: 'ghost target validated as far as the not-found lookup',
    }, officeToken)).status).toBe(404);
  });
});

describe('BIL: sorting the book by the money that is still owed', () => {
  // The whole point of a balance column is that it is NOT the size of the bill.
  // Read straight off the frozen corpus: one payer holding a bigger/cheaper row and a
  // smaller/dearer row — bigger total, smaller balance — so ordering by balance is
  // provably the reverse of ordering by total, and a server that sorted on `total`
  // would fail it. Nothing is written here: the reconciliation suites (etl, schema-
  // invariants) read these very tables mid-run, and an app row parked in them is a
  // row they will count as a lost import. A payer with ≤ 150 invoices keeps both rows
  // on the one page the endpoint hands back.
  let payer = 0;
  let hi = 0;   // bigger total, smaller balance
  let lo = 0;   // smaller total, bigger balance

  beforeAll(async () => {
    const pair = (await db.query(
      `SELECT x.payer_id, x.id AS hi, y.id AS lo
         FROM septic_app.invoices x
         JOIN septic_app.invoices y ON y.payer_id = x.payer_id AND y.id < x.id
        WHERE x.total > y.total
          AND (x.total - x.amount_paid) < (y.total - y.amount_paid)
          AND (SELECT count(*) FROM septic_app.invoices z WHERE z.payer_id = x.payer_id) <= 150
        ORDER BY x.payer_id, x.id
        LIMIT 1`,
    )).rows[0];
    if (!pair) {
      throw new Error('no payer in the corpus has a balance order that differs from its total order — the sort cannot be proven');
    }
    payer = Number(pair.payer_id); hi = Number(pair.hi); lo = Number(pair.lo);
  });

  const idsBy = async (sort: string, dir: 'asc' | 'desc') => {
    const r = await api('GET', `/invoices?payer_id=${payer}&sort=${sort}&dir=${dir}&limit=200`,
      undefined, officeToken);
    expect(r.status).toBe(200);
    expect(r.body.meta.sort).toBe(sort);
    expect(r.body.meta.dir).toBe(dir);
    return (r.body.data as any[]).map((x) => Number(x.id));
  };

  it('orders by the balance owed, which is the reverse of the order of the bill', async () => {
    const byBalance = await idsBy('balance', 'asc');
    expect(byBalance).toEqual(expect.arrayContaining([hi, lo]));
    // hi carries the bigger bill but the smaller balance, so the collections order puts it first.
    expect(byBalance.indexOf(hi)).toBeLessThan(byBalance.indexOf(lo));
    // The same two rows by bill size are the opposite way round — proof the sort reads
    // (total − amount_paid), not total.
    const byTotal = await idsBy('total', 'asc');
    expect(byTotal.indexOf(lo)).toBeLessThan(byTotal.indexOf(hi));
  });

  it('flipping the direction flips the whole book', async () => {
    const desc = await idsBy('balance', 'desc');
    expect(desc.indexOf(lo)).toBeLessThan(desc.indexOf(hi));
  });

  it('a sort the book does not keep is refused by naming the ones it does', async () => {
    const bad = await api('GET', '/invoices?sort=drop_tables', undefined, officeToken);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/sort must be one of/i);
    expect(bad.body.message).toMatch(/balance/);
  });
});

describe('BIL-05 × BIL-08: the adjusted invoice goes out as ONE document', () => {
  // Kiesner's exact shape: a $1,100 bill corrected down by a $20 discount.
  // Printing the original bills $1,100 for a $1,080 debt; printing the credit
  // alone is a −$20 page headed like an invoice. The consolidated statement is the
  // one paper that can go in an envelope — and its arithmetic is the database's,
  // not the browser's, so the balance the customer is asked for is the balance
  // the ledger holds (BIL-07).
  let head = 0;
  let credit = 0;

  beforeAll(async () => {
    const src = (await db.query(
      `SELECT payer_id, property_id, invoice_date FROM septic_app.invoices
        WHERE legacy_invoice_no IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )).rows[0];
    const headIns = await db.query(
      `INSERT INTO septic_app.invoices (payer_id, property_id, invoice_date,
          subtotal, tax_amount, total, amount_paid, status)
       VALUES ($1, $2, $3, 1100.00, 0, 1100.00, 0, 'open') RETURNING id`,
      [src.payer_id, src.property_id, src.invoice_date],
    );
    head = Number(headIns.rows[0].id);
    created.invoices.push(head);
    await db.query(
      `INSERT INTO septic_app.invoice_lines (invoice_id, legacy_product_code,
          description, quantity, unit_price, amount)
       VALUES ($1, 'SVC-STD', 'standard pump-out', 1, 1100, 1100)`,
      [head],
    );
    const a = await api('POST', `/invoices/${head}/adjust`, {
      lines: [{ legacy_product_code: 'SVC-STD', description: 'office discount',
                quantity: 1, unit_price: -20 }],
      reason: 'Discount',
    }, officeToken);
    expect(a.status).toBe(201);
    credit = Number(a.body.invoice.id);
    created.invoices.push(credit);
  });

  it('bills the original, then draws it down to the true balance — the header alone would over-collect', async () => {
    // The mailed paper bills the bill as it was issued ($1,100) and the ledger is
    // what takes the $20 off — not a header quietly rewritten to $1,080, which is
    // the number the customer never agreed to. And the book now agrees with the
    // statement (BIL-07 netting): there is no longer a $20 gap to fall into.
    const { body } = await api('GET', `/invoices/${head}`, undefined, officeToken);
    const s = body.data.statement;
    expect(s.invoice_id).toBe(head);                       // headed by the bill, not the credit
    expect(Number(s.total)).toBeCloseTo(1100, 2);          // billed as issued
    expect(Number(s.amount_paid)).toBeCloseTo(0, 2);
    expect(Number(s.balance_due)).toBeCloseTo(1080, 2);    // the correction, drawn off it
    const adj = s.ledger.find((e: any) => e.kind === 'adjustment');
    expect(adj).toBeTruthy();
    expect(Number(adj.amount)).toBeCloseTo(-20, 2);        // the $20 is a server-summed ledger line
    expect(Number(adj.running)).toBeCloseTo(1080, 2);
    expect(Number(body.data.balance)).toBeCloseTo(1080, 2); // the book no longer calls this a $1,100 debt
  });

  it('shows the original lines, then the correction as its own signed line carrying its reason', async () => {
    const { body } = await api('GET', `/invoices/${head}`, undefined, officeToken);
    const s = body.data.statement;
    expect(s.lines).toHaveLength(1);
    expect(Number(s.lines[0].amount)).toBeCloseTo(1100, 2);
    expect(s.adjustments).toHaveLength(1);
    expect(s.adjustments[0].adjust_reason).toMatch(/discount/i);   // the "why" rides with the line
    expect(s.adjustments[0].lines).toHaveLength(1);
    expect(Number(s.adjustments[0].lines[0].amount)).toBeCloseTo(-20, 2);
  });

  it('opening the credit hands back the single consolidated bill, still headed by the original', async () => {
    // "I can't send the adjusted invoice" — the credit was never the document to
    // send; the bill is, with the credit folded beneath it. Open either half, get
    // one netted paper headed by the original's id.
    const { body } = await api('GET', `/invoices/${credit}`, undefined, officeToken);
    const s = body.data.statement;
    expect(s.invoice_id).toBe(head);
    expect(Number(s.balance_due)).toBeCloseTo(1080, 2);
    expect(s.adjustments).toHaveLength(1);
    expect(s.adjustments[0].id).toBe(credit);
  });

  it('a plain bill with no correction nets to exactly itself', async () => {
    // Guard against the netting inventing a zero row or dropping the header's own
    // numbers for the overwhelmingly common no-adjustment invoice.
    const solo = await newOriginal();
    const { body } = await api('GET', `/invoices/${solo}`, undefined, officeToken);
    const s = body.data.statement;
    expect(s.invoice_id).toBe(solo);
    expect(s.adjustments).toHaveLength(0);
    expect(Number(s.balance_due)).toBeCloseTo(250, 2);
  });

  it('a payment to the corrected bill reconciles the ledger to zero and closes the account', async () => {
    // The complaint verbatim: he paid $1,080 on a $1,100 bill that carries a $20
    // credit, and the book called him partial / owing $20. Netted across the chain,
    // the bill, the correction and the receipt are one account — balance_due 0,
    // status paid — and the mailed copy draws its own running balance to zero.
    const pay = await api('POST', `/invoices/${head}/payments`,
      { amount: 1080, method: 'check', reference: 'T-PAID-ZERO' }, officeToken);
    expect(pay.status).toBe(201);
    const { body } = await api('GET', `/invoices/${head}`, undefined, officeToken);
    const s = body.data.statement;
    expect(Number(s.total)).toBeCloseTo(1100, 2);     // still billed as it was issued
    expect(Number(s.balance_due)).toBeCloseTo(0, 2);   // correction + receipt close it
    expect(Number(body.data.balance)).toBeCloseTo(0, 2);
    expect(body.data.status).toBe('paid');
    const kinds = s.ledger.map((e: any) => e.kind);
    expect(kinds).toContain('adjustment');
    expect(kinds).toContain('payment');
    expect(Number(s.ledger[s.ledger.length - 1].running)).toBeCloseTo(0, 2);
  });
});
