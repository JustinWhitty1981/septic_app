import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';
import { parseSort } from '../utils/sort';

function intParam(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

/**
 * The money a document really takes, measured against the whole correction
 * chain rather than the header alone.
 *
 * A correction is its own signed row (BIL-05: originals are never edited), so
 * the collectible figure for a bill is the header PLUS every document that
 * answers to it. Ignoring that is exactly the bug this closes: a $1,100 bill
 * discounted by a $20 correction and paid $1,080 is paid in full, yet the
 * header alone still reads "owe $20 / partial." Summed by the database (BIL-07:
 * the browser is not allowed to add money), across the same linear chain the
 * history walk uses.
 */
async function chainNet(
  run: (sql: string, params?: unknown[]) => Promise<any>,
  id: number,
): Promise<{ owed: number; paid: number }> {
  const rows = await run(
    `WITH RECURSIVE subtree(id) AS (
        SELECT $1::int
        UNION ALL
        SELECT k.id FROM septic_app.invoices k JOIN subtree s ON k.adjusts_invoice_id = s.id
      )
      SELECT coalesce(sum(total), 0)::numeric        AS owed,
             coalesce(sum(amount_paid), 0)::numeric  AS paid
        FROM septic_app.invoices
       WHERE id IN (SELECT id FROM subtree)`,
    [id],
  );
  const row = (Array.isArray(rows) ? rows : rows?.rows)?.[0] ?? {};
  return { owed: Number(row.owed ?? 0), paid: Number(row.paid ?? 0) };
}

/** The same sum, but for a page of invoices in one round-trip: each requested
 *  id is its own subtree root, so a leaf (or a lone bill) just returns itself. */
async function chainNetMap(
  ids: number[],
): Promise<Map<number, { owed: number; paid: number }>> {
  const out = new Map<number, { owed: number; paid: number }>();
  if (!ids.length) return out;
  const rows = await AppDataSource.query(
    `WITH RECURSIVE edge(root, id) AS (
        SELECT i.id, i.id FROM septic_app.invoices i WHERE i.id = ANY($1::int[])
        UNION ALL
        SELECT e.root, k.id FROM edge e JOIN septic_app.invoices k ON k.adjusts_invoice_id = e.id
      )
      SELECT e.root AS id, coalesce(sum(k.total), 0)::numeric       AS owed,
             coalesce(sum(k.amount_paid), 0)::numeric               AS paid
        FROM edge e JOIN septic_app.invoices k ON k.id = e.id
       GROUP BY e.root`,
    [ids],
  );
  for (const r of (Array.isArray(rows) ? rows : (rows as any).rows ?? [])) {
    out.set(Number(r.id), { owed: Number(r.owed), paid: Number(r.paid) });
  }
  return out;
}

/**
 * The status word that follows from owed versus paid — the same derivation the
 * payment endpoint applies, but measured against the corrected amount. A bill
 * discounted to $1,080 that has received $1,080 is `paid`, not `partial`; the
 * raw header would call it partial because 1,080 < 1,100, and that lie is what
 * the office saw.
 */
function netStatus(owed: number, paid: number, stored: string): string {
  if (stored === 'void') return 'void';
  if (owed - paid <= 0.005) return 'paid';
  if (paid > 0.005) return 'partial';
  return 'open';
}

/**
 * Invoice corrections (BIL-05).
 *
 * The legacy app had no way to adjust an invoice, which is the most plausible
 * reason 3,120 orphaned line items exist at all: someone who cannot correct a
 * document starts a new one and abandons the old. The correction document here
 * is what that missing affordance looks like when built honestly — the original
 * is *never* written (the 0020 trigger makes that literal), the adjustment is a
 * new invoice row that names the original, and the two together are the record.
 *
 * The signed money comes from 0021: an adjustment whose total is negative is
 * arithmetically honest, and the CHECKs that used to forbid it were written
 * when every row was an original.
 */

type Line = {
  service_event_id?: number; legacy_product_code?: string;
  service_type_id?: number; description?: string;
  quantity: number; unit_price: number;
};

export const adjustInvoice = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const id = intParam(req.params.id);
    if (id === null) {
      return res.status(404).json({ error: 'Invoice id must be a positive integer' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const lines = body.lines;
    if (!Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ error: 'lines must be a non-empty array of adjustment lines' });
    }

    // Validate the whole array before touching the database: half an adjustment
    // is exactly the abandoned-subform shape BIL-03 found.
    for (const [i, raw] of (lines as Line[]).entries()) {
      const where = `line ${i + 1}`;
      if (!raw || typeof raw !== 'object') {
        return res.status(400).json({ error: `${where} must be an object` });
      }
      const hasEvent = raw.service_event_id !== undefined && raw.service_event_id !== null;
      const hasProduct = typeof raw.legacy_product_code === 'string' && raw.legacy_product_code !== '';
      // BIL-01 at the boundary: the same rule the database now enforces, said in
      // the field's own name rather than as a constraint violation (NF-11).
      if (!hasEvent && !hasProduct) {
        return res.status(400).json({
          error: `${where} must reference a service event (service_event_id) or a product (legacy_product_code); a description alone is a sentence, not a charge`,
        });
      }
      if (hasEvent && intParam(raw.service_event_id) === null) {
        return res.status(400).json({ error: `${where}: service_event_id must be a positive integer` });
      }
      for (const name of ['quantity', 'unit_price'] as const) {
        const v = Number((raw as any)[name]);
        if (!Number.isFinite(v) || Math.abs(v) > 9999999.99) {
          return res.status(400).json({ error: `${where}: ${name} must be a finite number` });
        }
      }
      if (raw.description !== undefined && String(raw.description).length > 255) {
        return res.status(400).json({ error: `${where}: description must be 255 characters or fewer` });
      }
    }

    // BIL-05: a correction that cannot explain itself cannot be defended when the
    // customer calls. Read it after the line-shape loop so a malformed line still
    // hears the reference error first; and it comes from the body only as text —
    // who filed it is read off the login, never from here.
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({ error: 'An adjustment has to say why — the reason is the record (BIL-05).' });
    }
    const actorId = (req.user as { userId?: number }).userId ?? null;

    const outcome = await AppDataSource.transaction(async (em) => {
      const [original] = await em.query(
        `SELECT id, payer_id, property_id, kind FROM septic_app.invoices WHERE id = $1`,
        [id],
      );
      if (!original) return { kind: 'not-found' } as const;

      // An adjustment must land on the head of its own chain too, or the book
      // has two corrections of one document answering to nothing.
      const [prior] = await em.query(
        `SELECT id FROM septic_app.invoices
          WHERE adjusts_invoice_id = $1 AND kind <> 'void'
          ORDER BY id DESC LIMIT 1`,
        [id],
      );
      if (prior) return { kind: 'already-adjusted', by: Number(prior.id) } as const;

      for (const raw of lines as Line[]) {
        if (raw.service_event_id !== undefined && raw.service_event_id !== null) {
          const [ok] = await em.query(
            `SELECT 1 FROM septic_app.service_events WHERE id = $1`, [raw.service_event_id],
          );
          if (!ok) return { kind: 'unknown-event', value: raw.service_event_id } as const;
        }
      }

      const [today] = await em.query(`SELECT to_char(business_today(), 'YYYY-MM-DD') AS d`);
      const total = (lines as Line[]).reduce(
        (acc, l) => acc + Number(l.quantity) * Number(l.unit_price), 0,
      );
      // Money leaves this file rounded once, at the sum of exact products;
      // rounding each line then summing would reintroduce the drift at the
      // place it is least visible — the difference between two totals.
      const totalRounded = Math.round(total * 100) / 100;

      const [invoice] = await em.query(
        `INSERT INTO septic_app.invoices
           (payer_id, property_id, invoice_date, subtotal, tax_rate, tax_amount,
            total, amount_paid, kind, adjusts_invoice_id, created_by, adjust_reason)
         VALUES ($1, $2, $3::date, $4, 0, 0, $4, 0, 'adjustment', $5, $6, $7)
         RETURNING id, payer_id, property_id, kind, adjusts_invoice_id,
                   to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date,
                   subtotal, total, amount_paid, status::text AS status,
                   created_by, adjust_reason`,
        [original.payer_id, original.property_id, today.d, totalRounded, id, actorId, reason],
      );

      for (const raw of lines as Line[]) {
        await em.query(
          `INSERT INTO septic_app.invoice_lines
             (invoice_id, service_type_id, legacy_product_code, description,
              quantity, unit_price, amount, service_event_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            invoice.id, raw.service_type_id ?? null, raw.legacy_product_code ?? null,
            raw.description ?? null, Number(raw.quantity), Number(raw.unit_price),
            Math.round(Number(raw.quantity) * Number(raw.unit_price) * 100) / 100,
            raw.service_event_id ?? null,
          ],
        );
      }

      return { kind: 'written', invoice } as const;
    });

    if (outcome.kind === 'not-found') {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    if (outcome.kind === 'already-adjusted') {
      return res.status(409).json({
        error: `Invoice ${id} is already corrected by invoice ${outcome.by}. Adjust the current head of the chain, not the document it superseded.`,
        current_head: outcome.by,
      });
    }
    if (outcome.kind === 'unknown-event') {
      return res.status(400).json({ error: `service_event_id ${outcome.value} does not exist` });
    }

    res.status(201).json({ invoice: outcome.invoice });
  } catch (error) {
    res.status(500).json({ error: internalError(error) });
  }
};

/**
 * The invoice book, read (the screen BIL-05's corrections need to exist on).
 *
 * Filters mirror how the book is actually hunted: by payer, by status, by
 * date, or by invoice number when somebody is holding a paper stub. The list
 * carries the adjustment chain folded in — `adjusted_by` names the correction
 * if one exists, because an open invoice with a credit against it is a
 * different conversation than one without, and the office should not have to
 * click into each one to find out.
 */
export const listInvoices = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    if (status && !['open', 'paid', 'void', 'partial'].includes(status)) {
      return res.status(400).json({ error: 'status must be open, paid, void or partial' });
    }
    const payerId = req.query.payer_id == null ? null : intParam(req.query.payer_id);
    if (req.query.payer_id != null && payerId === null) {
      return res.status(400).json({ error: 'payer_id must be a positive integer' });
    }
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    const where: string[] = [];
    const params: unknown[] = [];
    if (status) { params.push(status); where.push(`i.status::text = $${params.length}`); }
    if (payerId) { params.push(payerId); where.push(`i.payer_id = $${params.length}`); }
    if (req.query.from) { params.push(String(req.query.from)); where.push(`i.invoice_date >= $${params.length}::date`); }
    if (req.query.to) { params.push(String(req.query.to)); where.push(`i.invoice_date <= $${params.length}::date`); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit, (page - 1) * limit);

    // Sorting: the book is read newest-first, but the office also hunts by
    // amount and by name. `payer_name` is a select-list alias and Postgres
    // sorts on it directly. `balance` is the money that is still owed, so it
    // is ordered by the same difference the row and the detail print — a
    // stored balance column would be the drift the rest of the ledger avoids.
    // Whitelisted — the ORDER BY fragment is
    // interpolated, so only these expressions may reach the SQL.
    const INVOICE_SORTS: Record<string, string> = {
      date: 'i.invoice_date', payer: 'payer_name',
      total: 'i.total', paid: 'i.amount_paid', status: 'i.status',
      balance: '(i.total - i.amount_paid)',
    };
    const parsed = parseSort(req.query, INVOICE_SORTS, 'date', 'desc');
    if ('error' in parsed) {
      return res.status(400).json({ success: false, message: parsed.error });
    }
    const sort = parsed.sort;

    const rows = await AppDataSource.query(
      `SELECT i.id, i.legacy_invoice_no, i.invoice_date, i.kind, i.status::text AS status,
              i.subtotal, i.tax_amount, i.total, i.amount_paid,
              case when coalesce(p.org_name, '') <> '' and trim(both from concat_ws(' ', p.first_name, p.last_name)) <> ''
                  then trim(both from concat_ws(' ', p.first_name, p.last_name)) || ' — ' || p.org_name
                  else coalesce(nullif(p.org_name, ''), trim(both from concat_ws(' ', p.first_name, p.last_name)))
                end AS payer_name,
              adj.id::int AS adjusted_by
         FROM septic_app.invoices i
         JOIN septic_app.payers p ON p.id = i.payer_id
         LEFT JOIN septic_app.invoices adj
           ON adj.adjusts_invoice_id = i.id
         ${whereSql}
        ORDER BY ${sort.column} ${sort.dir.toUpperCase()} NULLS LAST, i.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    // The book shows a bill's true position, not its header's: an invoice that
    // has been corrected owes the corrected amount, so a $1,100 bill with a
    // $20 credit and a $1,080 receipt reads `paid / $0`, not `partial / $20`.
    // Only heads (`kind = 'invoice'`) are collectible; a correction is a document,
    // not a debt, so its row keeps its own (non-collectible) figures. The whole
    // page is rolled up in one recursive query, not one per row.
    const netMap = await chainNetMap(
      (rows as any[]).filter((r) => r.kind === 'invoice').map((r) => Number(r.id)),
    );
    for (const r of rows as any[]) {
      if (r.kind === 'invoice') {
        const n = netMap.get(Number(r.id)) ?? { owed: Number(r.total), paid: Number(r.amount_paid) };
        r.balance = Math.round((n.owed - n.paid) * 100) / 100;
        r.status = netStatus(n.owed, n.paid, r.status);
      } else {
        r.balance = 0;
      }
    }

    const [count] = await AppDataSource.query(
      `SELECT count(*)::int AS total FROM septic_app.invoices i ${whereSql}`, params.slice(0, -2));

    return res.json({
      success: true, data: rows,
      meta: { total: count.total, page, limit,
              sort: String(req.query.sort ?? 'date'), dir: sort.dir },
    });
  } catch (error) {
    return res.status(500).json({ error: internalError(error) });
  }
};

/** One invoice and its lines — the detail the adjustment dialog reviews. */
export const getInvoice = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const id = intParam(req.params.id);
    if (id === null) {
      return res.status(404).json({ error: 'Invoice id must be a positive integer' });
    }
    // The mailing block rides along: the printable statement (BIL-08) is the
    // only delivery this business has — 0 payers have email (SCH-07) — and a
    // print view that had to make a second request for the address would be a
    // second request that can fail between the two halves of one document.
    const [head] = await AppDataSource.query(
      `SELECT i.*,
              case when coalesce(p.org_name, '') <> '' and trim(both from concat_ws(' ', p.first_name, p.last_name)) <> ''
                  then trim(both from concat_ws(' ', p.first_name, p.last_name)) || ' — ' || p.org_name
                  else coalesce(nullif(p.org_name, ''), trim(both from concat_ws(' ', p.first_name, p.last_name)))
                end AS payer_name,
              p.mailing_address, p.mailing_city, p.mailing_state, p.mailing_zip,
              pr.site_address, pr.site_city
         FROM septic_app.invoices i
         JOIN septic_app.payers p ON p.id = i.payer_id
         LEFT JOIN septic_app.properties pr ON pr.id = i.property_id
        WHERE i.id = $1`,
      [id],
    );
    if (!head) return res.status(404).json({ error: 'Invoice not found' });

    const [lines, payments] = await Promise.all([
      AppDataSource.query(
        `SELECT id, service_event_id, legacy_product_code, service_type_id,
                description, quantity, unit_price, amount, taxable
           FROM septic_app.invoice_lines WHERE invoice_id = $1 ORDER BY id`,
        [id],
      ),
      AppDataSource.query(
        `SELECT p.id, p.amount, p.method, p.note, p.reference, p.paid_at,
                u.first_name || ' ' || u.last_name AS received_by
           FROM septic_app.payments p
           LEFT JOIN septic_app.users u ON u.id = p.received_by
          WHERE p.invoice_id = $1 ORDER BY p.paid_at NULLS LAST, p.id`,
        [id],
      ),
    ]);
    // BIL-05: the whole correction chain this document belongs to, oldest first.
    // Walk the link up to the original — a complaint opened on a correction still
    // has to see the bill it corrects — then gather everything hanging beneath it.
    // The chain is linear (one head per document, enforced at write), so ancestors
    // up plus descendants down is the complete record; there is no sibling branch.
    const chainIds = new Set<number>([id]);
    let up = id;
    for (;;) {
      const [row] = await AppDataSource.query(
        `SELECT adjusts_invoice_id FROM septic_app.invoices WHERE id = $1`, [up]) as any[];
      const parent = row?.adjusts_invoice_id as number | null | undefined;
      if (parent == null || chainIds.has(parent)) break;
      chainIds.add(parent); up = parent;
    }
    let frontier = [up];
    while (frontier.length) {
      const kids = await AppDataSource.query(
        `SELECT id FROM septic_app.invoices WHERE adjusts_invoice_id = ANY($1::int[])`,
        [frontier]) as any[];
      const next: number[] = [];
      for (const k of kids) {
        const kid = Number(k.id);
        if (!chainIds.has(kid)) { chainIds.add(kid); next.push(kid); }
      }
      frontier = next;
    }
    const history = await AppDataSource.query(
      `SELECT i.id, i.legacy_invoice_no, i.kind,
              to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
              i.status::text AS status, i.subtotal::text AS subtotal,
              i.tax_amount::text AS tax_amount, i.total::text AS total,
              i.amount_paid::text AS amount_paid, i.adjusts_invoice_id,
              i.adjust_reason, i.created_by,
              to_char(i.created_at, 'YYYY-MM-DD') AS created_on,
              CASE WHEN u.id IS NULL THEN NULL
                   ELSE trim(both from concat_ws(', ', u.last_name, u.first_name)) END AS created_by_name
         FROM septic_app.invoices i
         LEFT JOIN septic_app.users u ON u.id = i.created_by
        WHERE i.id = ANY($1::int[])
        ORDER BY i.id ASC`,
      [[...chainIds]],
    ) as any[];

    // BIL-05 × BIL-08: the one document the office can actually mail. A correction
    // is its own signed row — never an edit — so "send the adjusted invoice" cannot
    // mean printing the original (it would bill $1,100 for a $1,080 debt) nor the
    // correction alone (a −$20 page headed like an invoice is how refunds get
    // argued about). The answer is to fold the head and every document hanging off
    // it into one paper: the original's lines, then each correction as its own
    // signed line carrying its reason, netted to what the customer truly owes.
    // Every figure is summed by the database across the chain — a balance added at
    // the browser is a balance that drifts (BIL-07) — over the same linear chain
    // the history walk below assembled (there is no void on an invoice document;
    // a cancelled correction is superseded by adjusting the head, not flagged).
    const ids = [...chainIds];
    const [netHead, adjDocs, headLines, chainPayments] = await Promise.all([
      AppDataSource.query(
        `SELECT coalesce(sum(subtotal), 0)::text    AS subtotal,
                coalesce(sum(tax_amount), 0)::text  AS tax_amount,
                coalesce(sum(total), 0)::text       AS total,
                coalesce(sum(amount_paid), 0)::text AS amount_paid
           FROM septic_app.invoices
          WHERE id = ANY($1::int[])`,
        [ids],
      ),
      AppDataSource.query(
        `SELECT i.id AS doc, to_char(i.invoice_date, 'YYYY-MM-DD') AS doc_date,
                i.kind, i.adjust_reason, i.total::text AS doc_total, i.legacy_invoice_no,
                l.id, l.service_event_id, l.legacy_product_code, l.service_type_id,
                l.description, l.quantity::text AS quantity,
                l.unit_price::text AS unit_price, l.amount::text AS amount, l.taxable
           FROM septic_app.invoices i
           JOIN septic_app.invoice_lines l ON l.invoice_id = i.id
          WHERE i.id = ANY($1::int[]) AND i.id <> $2
          ORDER BY i.id, l.id`,
        [ids, up],
      ),
      AppDataSource.query(
        `SELECT id, service_event_id, legacy_product_code, service_type_id,
                description, quantity::text AS quantity, unit_price::text AS unit_price,
                amount::text AS amount, taxable
           FROM septic_app.invoice_lines WHERE invoice_id = $1 ORDER BY id`,
        [up],
      ),
      AppDataSource.query(
        `SELECT p.id, p.invoice_id, p.amount::text AS amount, p.method, p.note,
                p.reference, p.paid_at,
                u.first_name || ' ' || u.last_name AS received_by
           FROM septic_app.payments p
           LEFT JOIN septic_app.users u ON u.id = p.received_by
          WHERE p.invoice_id = ANY($1::int[])
          ORDER BY p.paid_at NULLS LAST, p.id`,
        [ids],
      ),
    ]) as any[];

    const adjustments: any[] = [];
    let cur: any = null;
    for (const r of adjDocs as any[]) {
      if (!cur || cur.id !== Number(r.doc)) {
        cur = { id: Number(r.doc), invoice_date: r.doc_date, kind: r.kind,
                adjust_reason: r.adjust_reason, total: r.doc_total,
                number: r.legacy_invoice_no != null ? String(r.legacy_invoice_no) : `#${r.doc}`,
                lines: [] as any[] };
        adjustments.push(cur);
      }
      cur.lines.push({ id: r.id, service_event_id: r.service_event_id,
                       legacy_product_code: r.legacy_product_code,
                       service_type_id: r.service_type_id, description: r.description,
                       quantity: r.quantity, unit_price: r.unit_price,
                       amount: r.amount, taxable: r.taxable });
    }

    // Each SELECT above answers with its rows array (TypeORM's SELECT shape), so
    // the single-row aggregate is element 0, not the object the array holds.
    const net = (netHead as any[])[0] ?? {};
    const headRow = (history as any[]).find((h) => Number(h.id) === up) ?? {};

    // The reconciling ledger the statement prints under "payments and adjustments."
    // It opens on the bill as issued (the head's own total) and is drawn down to
    // what is actually owed by two kinds of line: each correction, referencing the
    // document number it was filed under, and each receipt. The running balance is
    // computed here — the customer's copy has to add up in front of them, and it is
    // not the browser's arithmetic to get wrong (BIL-07).
    const headTotal = Number(head.total);
    const entries: any[] = [
      ...adjustments.map((a) => ({
        kind: 'adjustment', id: a.id, order: 0, date: a.invoice_date,
        ref: `invoice #${a.number}`, label: a.adjust_reason || 'correction',
        amount: Number(a.total), step: Number(a.total),   // signed total of the doc
      })),
      ...(chainPayments as any[]).map((p) => ({
        kind: 'payment', id: p.id, order: 1, date: p.paid_at,
        ref: p.reference ? `#${p.reference}` : null,
        label: `${p.method} · ${p.received_by ?? 'legacy import'}`,
        amount: Number(p.amount), step: -Number(p.amount), // a receipt is money in
      })),
    ];
    entries.sort((x, y) =>
      String(x.date ?? '').localeCompare(String(y.date ?? ''))
      || x.order - y.order || x.id - y.id);
    let running = headTotal;
    const ledger = entries.map((e) => {
      running = Math.round((running + e.step) * 100) / 100;
      return { kind: e.kind, id: e.id, date: e.date, ref: e.ref,
               label: e.label, amount: e.amount.toFixed(2), running: running.toFixed(2) };
    });

    const owed = Number(net.total ?? headTotal);
    const paid = Number(net.amount_paid ?? head.amount_paid);

    const statement = {
      invoice_id: up,                                    // the head: the number the customer reads back
      display_number: headRow.legacy_invoice_no != null
        ? String(headRow.legacy_invoice_no) : `#${up}`,  // mailed from the credit, still headed by the bill
      subtotal: head.subtotal, tax_amount: head.tax_amount,   // the bill as issued…
      total: head.total, amount_paid: head.amount_paid,
      balance_due: (Math.round((owed - paid) * 100) / 100).toFixed(2), // …netted to what is truly owed
      lines: headLines, ledger, adjustments,
    };

    // The book and the detail show the head's corrected position too: a $1,100 bill
    // with a $20 credit and a $1,080 receipt is `paid`, not `partial / $20`. The
    // raw header is a document; the collectible figure is the chain's.
    const netted = head.kind === 'invoice';
    return res.json({
      success: true,
      data: { ...head,
        balance: netted ? (Math.round((owed - paid) * 100) / 100)
                        : Number(head.total) - Number(head.amount_paid),
        status: netted ? netStatus(owed, paid, head.status) : head.status,
        lines, payments, history, statement },
    });
  } catch (error) {
    return res.status(500).json({ error: internalError(error) });
  }
};

// Mirrors the payment_method enum. 'ach' is deliberately absent: ALTER TYPE
// ADD VALUE cannot run inside a transaction, and a migration that has to
// escape the runner's transaction is a bigger decision than this list. Until
// the office says otherwise, ACH is 'other' with the bank in the note.
const METHODS = ['check', 'cash', 'card', 'other'] as const;

/**
 * Record a payment (BIL-06).
 *
 * Two rules give this endpoint its shape.
 *
 * 1. The receipt is the row; `amount_paid` is the echo. The header column is
 *    recomputed as the SUM of the payment rows — never incremented — so the
 *    arithmetic is idempotent and self-healing: post against an invoice whose
 *    column has drifted and the recompute fixes it rather than compounding the
 *    error. (The 0020 trigger was written knowing: money columns are frozen,
 *    payment bookkeeping must keep moving. This is the bookkeeping.)
 * 2. Overpayment is refused with the balance named. $50 against a $185 balance
 *    is a transposed digit, and the person holding the check is one sentence
 *    away from fixing it. Silently banking the extra would put credit on an
 *    invoice that cannot carry credit — refunds are adjustment invoices
 *    (BIL-05), one ledger of corrections, not two.
 *
 * The lock is the codebase's pattern again: SELECT ... FOR UPDATE on the
 * header, so two clerks posting at once read the same balance and only one
 * receipt fits inside it.
 */
export const recordPayment = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const id = intParam(req.params.id);
    if (id === null) {
      return res.status(404).json({ error: 'Invoice id must be a positive integer' });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) {
      return res.status(400).json({ error: 'amount must be a positive number of cents' });
    }
    const method = body.method === undefined ? 'other' : String(body.method);
    if (!METHODS.includes(method as typeof METHODS[number])) {
      return res.status(400).json({ error: `method must be one of: ${METHODS.join(', ')}` });
    }
    const note = body.note === undefined || body.note === null ? null : String(body.note);
    if (note !== null && note.length > 500) {
      return res.status(400).json({ error: 'note must be 500 characters or fewer' });
    }
    const reference = body.reference === undefined || body.reference === null
      ? null : String(body.reference);
    if (reference !== null && reference.length > 50) {
      return res.status(400).json({ error: 'reference must be 50 characters or fewer' });
    }
    const uuid = body.client_uuid;
    if (uuid !== undefined
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(uuid))) {
      return res.status(400).json({ error: 'client_uuid must be a UUID' });
    }

    const outcome = await AppDataSource.transaction(async (em) => {
      if (uuid) {
        const [prior] = await em.query(
          `SELECT id, invoice_id, amount, method, note, paid_at, client_uuid
             FROM septic_app.payments WHERE client_uuid = $1`, [uuid],
        );
        if (prior) return { kind: 'replay', payment: prior } as const;
      }

      const [inv] = await em.query(
        `SELECT id, total, status::text AS status, kind, amount_paid
           FROM septic_app.invoices WHERE id = $1 FOR UPDATE`, [id],
      );
      if (!inv) return { kind: 'no-invoice' } as const;
      if (inv.status === 'void') return { kind: 'void' } as const;

      const [summed] = await em.query(
        `SELECT coalesce(sum(amount), 0)::numeric AS paid
           FROM septic_app.payments WHERE invoice_id = $1`, [id],
      );
      // The cap and the status are measured against the corrected chain, not the
      // raw header: a $1,100 bill discounted to $1,080 stops accepting money at
      // $1,080 (the $20 that used to be collectible here is not a debt), and a
      // receipt that reaches the corrected figure marks it paid, not partial.
      const { owed } = await chainNet((s, p) => em.query(s, p), id);
      const balance = Math.round((owed - Number(summed.paid)) * 100) / 100;
      if (amount > balance + 1e-9) {
        return { kind: 'over', balance } as const;
      }

      const [payment] = await em.query(
        `INSERT INTO septic_app.payments
           (invoice_id, amount, method, received_by, note, reference, client_uuid)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (client_uuid) WHERE client_uuid IS NOT NULL DO NOTHING
         RETURNING id, amount, method, note, reference, paid_at, client_uuid`,
        [id, amount, method, (req.user as { userId: number }).userId, note, reference,
          uuid ?? null],
      );
      if (!payment) {
        const [winner] = await em.query(
          `SELECT id, amount, method, note, reference, paid_at, client_uuid
             FROM septic_app.payments WHERE client_uuid = $1`, [uuid],
        );
        return { kind: 'replay', payment: winner } as const;
      }

      // The echo: re-summed from the receipts, never incremented, then the
      // status word that follows from the comparison — against the corrected
      // amount owed (`$2`), so a fully-credited-and-paid bill reads `paid`.
      await em.query(
        `UPDATE septic_app.invoices
            SET amount_paid = (SELECT coalesce(sum(amount),0) FROM septic_app.payments
                                WHERE invoice_id = $1),
                status = CASE
                  WHEN (SELECT coalesce(sum(amount),0) FROM septic_app.payments
                          WHERE invoice_id = $1) >= $2::numeric THEN 'paid'::invoice_status
                  WHEN (SELECT coalesce(sum(amount),0) FROM septic_app.payments
                          WHERE invoice_id = $1) > 0 THEN 'partial'::invoice_status
                  ELSE status
                END
          WHERE id = $1`,
        [id, owed],
      );
      // A SELECT afterwards, deliberately: TypeORM's query() hands UPDATE and
      // INSERT ... RETURNING back in different shapes ([rows, count] vs rows),
      // and one SELECT whose shape never changes is worth more than a clever
      // destructuring of two.
      const [after] = await em.query(
        `SELECT status::text AS status, amount_paid
           FROM septic_app.invoices WHERE id = $1`, [id],
      );
      after.balance = Math.round((owed - Number(after.amount_paid)) * 100) / 100;
      return { kind: 'written', payment, invoice: after } as const;
    });

    if (outcome.kind === 'no-invoice') return res.status(404).json({ error: 'Invoice not found' });
    if (outcome.kind === 'void') {
      return res.status(409).json({ error: 'A void invoice is not collectible; its money story is already closed' });
    }
    if (outcome.kind === 'over') {
      return res.status(409).json({
        error: `Payment of ${amount.toFixed(2)} exceeds the balance of ${outcome.balance.toFixed(2)}. `
             + 'Refunds and credits are adjustment invoices, not overpayments.',
        balance: outcome.balance,
      });
    }
    if (outcome.kind === 'replay') {
      return res.status(200).json({ payment: outcome.payment, replay: true });
    }
    return res.status(201).json({ payment: outcome.payment, invoice: outcome.invoice });
  } catch (error) {
    return res.status(500).json({ error: internalError(error) });
  }
};
/**
 * BIL-20: hand-built invoices — the billing queue's drain, and the invoice
 * desk's blank page.
 *
 * Two doors, one endpoint: the queue posts the pump-outs it is holding, the
 * invoice page posts whatever the clerk typed. Either way the rules are the
 * ones the rest of the money already obeys:
 *
 *  - Every line names exactly one lawful thing (BIL-01, extended by 0033
 *    with the price-list reference): a service event, a price-list item, or
 *    a legacy product code. "Description only" is illegal — a description
 *    is what an invented charge wears.
 *  - The client may believe a quantity and a price; it may not believe a
 *    total. Amounts, subtotal, tax and total are computed in SQL from the
 *    numbers the line sent (BIL-04 — the bid conversion set this precedent,
 *    and manual creation must not be the hole in it).
 *  - The tax stamp is the company's rate at creation — zero for a payer
 *    marked tax-exempt, a fact the legacy `tax_exempt` column asserted and
 *    nothing ever consulted.
 *  - An event may be billed once. The claim is checked *inside* the
 *    transaction that locks the event rows (`FOR UPDATE`, id order so two
 *    clerks cannot deadlock), so the loser of a race gets a 409 naming the
 *    invoice that won, not a second invoice.
 *
 * And the queue drains by construction: `GET /ledger/unbilled-events`
 * already means "no line names me", so the POST that adds a line *is* the
 * removal. No queue status, no sync job, nothing that could disagree.
 */

const QTY_RE = /^\d{1,6}(\.\d{1,2})?$/;
const PRICE_RE = /^\d{1,7}(\.\d{1,2})?$/;
const EVENT_ID_RE = /^\d{1,19}$/;

interface NewLine {
  n: number;
  description: string;
  quantity: string;
  unit_price: string;
  service_event_id: string | null;
  bid_item_id: number | null;
  legacy_product_code: string | null;
  taxable: boolean;
}

type CreateOutcome =
  | { kind: 'ok'; invoice: Record<string, unknown>; line_count: number }
  | { kind: 'error'; status: number; message: string };

export const createInvoice = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const payerId = intParam(body.payer_id);
    if (payerId === null) {
      return res.status(400).json({ success: false, message: 'payer_id must be a positive integer' });
    }
    let propertyId: number | null = null;
    if (body.property_id !== undefined && body.property_id !== null && body.property_id !== '') {
      propertyId = intParam(body.property_id);
      if (propertyId === null) {
        return res.status(400).json({ success: false, message: 'property_id must be a positive integer' });
      }
    }

    const rawLines = body.lines;
    if (!Array.isArray(rawLines) || !rawLines.length) {
      return res.status(400).json({ success: false, message: 'lines must be a non-empty array' });
    }
    if (rawLines.length > 100) {
      return res.status(400).json({ success: false, message: 'one invoice may carry at most 100 lines' });
    }

    // Validate the whole document before the database sees any of it — half
    // an invoice is the abandoned-subform shape BIL-03 found in the legacy
    // corpus, and it stays outside this system.
    const lines: NewLine[] = [];
    const seenEvents = new Map<string, number>();
    for (const [i, raw] of (rawLines as Record<string, unknown>[]).entries()) {
      const where = `line ${i + 1}`;
      if (!raw || typeof raw !== 'object') {
        return res.status(400).json({ success: false, message: `${where} must be an object` });
      }
      const description = typeof raw.description === 'string' ? raw.description.trim() : '';
      if (!description || description.length > 255) {
        return res.status(400).json({ success: false,
          message: `${where} needs a description of 1–255 characters` });
      }
      const quantity = String(raw.quantity ?? '');
      const unitPrice = String(raw.unit_price ?? '');
      if (!QTY_RE.test(quantity) || Number(quantity) <= 0) {
        return res.status(400).json({ success: false,
          message: `${where}: quantity must be a positive number (got "${quantity}")` });
      }
      if (!PRICE_RE.test(unitPrice)) {
        return res.status(400).json({ success: false,
          message: `${where}: unit_price must be a non-negative number of at most 2 decimals` });
      }

      const eventRaw = raw.service_event_id;
      const hasEvent = eventRaw !== undefined && eventRaw !== null && eventRaw !== '';
      const hasItem = raw.bid_item_id !== undefined && raw.bid_item_id !== null && raw.bid_item_id !== '';
      const hasProduct = typeof raw.legacy_product_code === 'string'
        && raw.legacy_product_code.trim() !== '';
      const refs = [hasEvent, hasItem, hasProduct].filter(Boolean).length;
      if (refs === 0) {
        return res.status(400).json({ success: false,
          message: `${where} must reference a service event, a price-list item, or a legacy product code — a description alone is a sentence, not a charge` });
      }
      if (refs > 1) {
        return res.status(400).json({ success: false,
          message: `${where} references more than one thing; a line bills one thing, or it bills the same truck twice` });
      }

      let serviceEventId: string | null = null;
      let bidItemId: number | null = null;
      let legacyProductCode: string | null = null;
      if (hasEvent) {
        serviceEventId = String(eventRaw);
        if (!EVENT_ID_RE.test(serviceEventId)) {
          return res.status(400).json({ success: false,
            message: `${where}: service_event_id must be a positive integer` });
        }
        const first = seenEvents.get(serviceEventId);
        if (first !== undefined) {
          return res.status(400).json({ success: false,
            message: `lines ${first} and ${i + 1} bill the same service event; that is one charge wearing two lines` });
        }
        seenEvents.set(serviceEventId, i + 1);
      } else if (hasItem) {
        bidItemId = intParam(raw.bid_item_id);
        if (bidItemId === null) {
          return res.status(400).json({ success: false,
            message: `${where}: bid_item_id must be a positive integer` });
        }
      } else {
        legacyProductCode = (raw.legacy_product_code as string).trim();
        if (legacyProductCode.length > 20) {
          return res.status(400).json({ success: false,
            message: `${where}: legacy_product_code is at most 20 characters` });
        }
      }
      // A line opts out of tax only by an explicit falsy word. Absent — or a
      // checkbox that posted 'true' — it is taxable, the way every line always
      // was (0034); the office takes a line off the taxable base by unchecking it.
      const taxable = !(raw.taxable === false || raw.taxable === 'false'
        || raw.taxable === 0 || raw.taxable === '0');
      lines.push({
        n: i + 1, description, quantity, unit_price: unitPrice,
        service_event_id: serviceEventId, bid_item_id: bidItemId,
        legacy_product_code: legacyProductCode, taxable,
      });
    }

    const outcome = await AppDataSource.transaction(async (em) => {
      const [payer] = await em.query(
        `SELECT id, tax_exempt,
                case when coalesce(org_name, '') <> ''
                        and trim(both from concat_ws(' ', first_name, last_name)) <> ''
                    then trim(both from concat_ws(' ', first_name, last_name)) || ' — ' || org_name
                    else coalesce(nullif(org_name, ''), trim(both from concat_ws(' ', first_name, last_name)))
                  end AS name
           FROM septic_app.payers WHERE id = $1`,
        [payerId],
      ) as any[];
      if (!payer) return { kind: 'error', status: 404, message: `No payer has id ${payerId}.` } as CreateOutcome;

      if (propertyId !== null) {
        const [prop] = await em.query(
          `SELECT 1 FROM septic_app.properties WHERE id = $1`, [propertyId]) as any[];
        if (!prop) return { kind: 'error', status: 404, message: `No property has id ${propertyId}.` } as CreateOutcome;
      }

      // The event claims, locked in id order. Everything below this line and
      // the INSERT above the COMMIT share one transaction: the check-then-act
      // gap is exactly where two clerks double-bill one pump-out.
      const eventIds = [...new Set(
        lines.filter((l) => l.service_event_id !== null).map((l) => l.service_event_id as string),
      )].sort((a, b) => Number(a) - Number(b));
      if (eventIds.length) {
        const locked = await em.query(
          `SELECT id, status::text AS status
             FROM septic_app.service_events
            WHERE id = ANY($1::bigint[])
            ORDER BY id
              FOR UPDATE`,
          [eventIds],
        ) as any[];
        const byId = new Map(locked.map((r: any) => [String(r.id), r]));
        for (const id of eventIds) {
          const ev = byId.get(id);
          if (!ev) {
            return { kind: 'error', status: 404, message: `No service event has id ${id}.` } as CreateOutcome;
          }
          if (ev.status !== 'completed') {
            return { kind: 'error', status: 409,
              message: `Event ${id} is ${ev.status}, not completed — only finished work is billable.` } as CreateOutcome;
          }
        }
        const superseded = await em.query(
          `SELECT e.id, c.id AS head
             FROM septic_app.service_events e
             JOIN septic_app.service_events c ON c.corrects_event_id = e.id
            WHERE e.id = ANY($1::bigint[])`,
          [eventIds],
        ) as any[];
        if (superseded.length) {
          const r = superseded[0];
          return { kind: 'error', status: 409,
            message: `Event ${r.id} has been corrected — event ${r.head} is the current record. Bill the current record; a chain bills once.` } as CreateOutcome;
        }
        const billed = await em.query(
          `SELECT il.service_event_id, il.invoice_id
             FROM septic_app.invoice_lines il
            WHERE il.service_event_id = ANY($1::bigint[])
            ORDER BY il.id`,
          [eventIds],
        ) as any[];
        if (billed.length) {
          const r = billed[0];
          return { kind: 'error', status: 409,
            message: `Event ${r.service_event_id} is already billed — invoice ${r.invoice_id} names it.` } as CreateOutcome;
        }
      }

      const itemIds = [...new Set(
        lines.filter((l) => l.bid_item_id !== null).map((l) => l.bid_item_id as number),
      )].sort((a, b) => a - b);
      if (itemIds.length) {
        const found = await em.query(
          `SELECT id FROM septic_app.bid_items WHERE id = ANY($1::int[])`, [itemIds]) as any[];
        const have = new Set(found.map((r: any) => Number(r.id)));
        for (const id of itemIds) {
          if (!have.has(id)) {
            return { kind: 'error', status: 404, message: `No price-list item has id ${id}.` } as CreateOutcome;
          }
        }
      }

      const [settings] = await em.query(
        `SELECT sales_tax_rate::text AS rate FROM septic_app.company_settings WHERE id = 1`) as any[];
      const rate = payer.tax_exempt ? '0' : settings.rate;

      // All money arithmetic in one SQL statement: line amounts, the sum,
      // the stamp, the total. JavaScript never touches a number here (BIL-04).
      const valueRows: string[] = [];
      const moneyParams: unknown[] = [];
      for (const l of lines) {
        const q = moneyParams.push(l.quantity);
        const p = moneyParams.push(l.unit_price);
        const tx = moneyParams.push(l.taxable);
        // n travels in the VALUES list itself: a VALUES CTE has no declared
        // order, and a window function over it would guess where each line
        // belongs. The line numbers of the document ride with their money.
        valueRows.push(`(${l.n}, $${q}::numeric, $${p}::numeric, $${tx}::boolean)`);
      }
      moneyParams.push(rate);
      const ratePh = `$${moneyParams.length}`;
      // Tax falls on the taxable lines only (0034). One rounding, at the sum of
      // that base — the same single rounding the whole-invoice total has always
      // used — so `total = subtotal + tax_amount` stays exact, and a document
      // that taxes every line is bit-for-bit what it was before the column.
      const computed = await em.query(
        `WITH v (n, qty, price, taxable) AS (VALUES ${valueRows.join(', ')}),
             a  AS (SELECT n, ROUND(qty * price, 2) AS amount, taxable FROM v),
             s  AS (SELECT COALESCE(SUM(amount), 0) AS sub,
                          COALESCE(SUM(amount) FILTER (WHERE taxable), 0) AS taxable_sub
                     FROM a)
         SELECT a.n::int AS n,
                a.amount::text AS amount,
                s.sub::text AS subtotal,
                ROUND(s.taxable_sub * ${ratePh}::numeric, 2)::text AS tax_amount,
                (s.sub + ROUND(s.taxable_sub * ${ratePh}::numeric, 2))::text AS total
           FROM a, s
          ORDER BY a.n`,
        moneyParams,
      ) as any[];

      const totals = computed[0];
      const [invoice] = await em.query(
        // created_by is attribution off the login (0035) — the office token that
        // posted this bill, never a field the request could set for itself.
        `INSERT INTO septic_app.invoices
           (payer_id, property_id, invoice_date, subtotal, tax_rate, tax_amount, total, created_by)
         VALUES ($1, $2, septic_app.business_today(), $3::numeric, $4::numeric,
                 $5::numeric, $6::numeric, $7)
         RETURNING id, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date,
                   subtotal::text AS subtotal, tax_rate::text AS tax_rate,
                   tax_amount::text AS tax_amount, total::text AS total,
                   status::text AS status`,
        [payerId, propertyId, totals.subtotal, rate, totals.tax_amount, totals.total,
         (req.user as { userId?: number }).userId ?? null],
      ) as any[];

      const lineRows: string[] = [];
      const lineParams: unknown[] = [invoice.id];
      for (const l of lines) {
        const start = lineParams.length + 1;   // 1-based index of the first param pushed below
        lineParams.push(l.description, l.quantity, l.unit_price, computed[l.n - 1].amount,
          l.service_event_id, l.bid_item_id, l.legacy_product_code, l.taxable);
        lineRows.push(`($1, $${start}, $${start + 1}::numeric, $${start + 2}::numeric, $${start + 3}::numeric,
                        $${start + 4}::bigint, $${start + 5}::int, $${start + 6}, $${start + 7}::boolean)`);
      }
      await em.query(
        `INSERT INTO septic_app.invoice_lines
           (invoice_id, description, quantity, unit_price, amount,
            service_event_id, bid_item_id, legacy_product_code, taxable)
         VALUES ${lineRows.join(', ')}`,
        lineParams,
      );

      return {
        kind: 'ok',
        invoice: {
          id: Number(invoice.id),
          payer_id: payerId,
          property_id: propertyId,
          payer_name: payer.name,
          invoice_date: invoice.invoice_date,
          subtotal: invoice.subtotal,
          tax_rate: rate,
          tax_amount: invoice.tax_amount,
          total: invoice.total,
          status: invoice.status,
        },
        line_count: lines.length,
      } as CreateOutcome;
    });

    if (outcome.kind === 'ok') {
      return res.status(201).json({ success: true, data: outcome });
    }
    return res.status(outcome.status).json({ success: false, message: outcome.message });
  } catch (error) {
    return res.status(500).json({ error: internalError(error) });
  }
};
