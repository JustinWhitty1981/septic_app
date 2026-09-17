import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';

/**
 * Bids (BIL-10..16): the document, its lines, its signature, and the invoice.
 *
 * The shape of the whole feature is one sentence — *the list is a reference, the
 * bid is a record, the signature is a border* — and every endpoint below is
 * that sentence applied to one verb:
 *
 *  - Lines COPY the price list at the moment of adding. A later edit to the
 *    list is Tuesday; this document was sent on Monday.
 *  - Money is arithmetic the keyboard may not type: `line_total` is a
 *    generated column and the bid total is a SUM, never a written value — a
 *    body that names a total is refused by naming the field (SCH-11's rule,
 *    the third time it has been the right one).
 *  - Approval is a signature: stamped by the server (who and when and the tax
 *    rate of that instant, BIL-16), and after it the document does not move —
 *    not because a trigger freezes it (bids are too young to have earned one,
 *    unlike invoices' 61 years) but because every mutation endpoint checks
 *    the status *under the row lock* before touching a line.
 *  - Conversion is one transaction and happens once: header, lines, and the
 *    bid's `invoice_id` either all exist or none do, and a second attempt
 *    names the invoice that already exists instead of making a second one.
 *
 * Reads are open to any authenticated user, as everywhere: a driver who can
 * see a site can see that somebody quoted the work, and the gate that matters
 * is on writes.
 */

const intParam = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * A quantity as the schema defines one: positive, at most two decimal places
 * — 3 hours, 100 feet, and half an hour all fit; 0.333333 hours is a
 * calculator argument, not a line item.
 */
const qty = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return /^(?:[1-9]\d*|0)(?:\.\d{1,2})?$/.test(s) && Number(s) > 0 ? s : null;
};

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max ? v.trim() : null;

/**
 * The status sentences, shared by every mutation so "why did the button die"
 * has one answer everywhere. Naming the status is the point (NF-11): a clerk
 * told `409` guesses; a clerk told "invoice 4102 already exists" phones the
 * right person.
 */
const statusRefusal = (id: number, status: string, invoiceId: number | null):
  { message: string } => ({
  message:
    status === 'approved'
      ? `Bid ${id} is approved — a signature does not accept edits. Revise means a new bid.`
      : status === 'declined'
        ? `Bid ${id} was declined — a declined bid is a decision. Make a new bid to try again.`
        : `Bid ${id} is already invoiced as invoice ${invoiceId}. Correct the invoice (BIL-05), not the bid.`,
});

/** Every computed money figure, from the row and the settings rate — server-side. */
const TOTALS = `
  COALESCE((SELECT SUM(l.line_total) FROM septic_app.bid_lines l
             WHERE l.bid_id = b.id), 0)                          AS subtotal,
  (SELECT count(*)::int FROM septic_app.bid_lines l
    WHERE l.bid_id = b.id)                                       AS line_count,
  CASE WHEN b.status = 'draft' THEN s.sales_tax_rate ELSE b.tax_rate END AS eff_tax_rate,
  (b.status = 'draft')                                           AS tax_estimated,
  ROUND(COALESCE((SELECT SUM(l.line_total) FROM septic_app.bid_lines l
                   WHERE l.bid_id = b.id), 0)
        * (CASE WHEN b.status = 'draft' THEN s.sales_tax_rate ELSE b.tax_rate END), 2)
                                                                 AS tax_amount,
  COALESCE((SELECT SUM(l.line_total) FROM septic_app.bid_lines l
             WHERE l.bid_id = b.id), 0)
    + ROUND(COALESCE((SELECT SUM(l.line_total) FROM septic_app.bid_lines l
                       WHERE l.bid_id = b.id), 0)
            * (CASE WHEN b.status = 'draft' THEN s.sales_tax_rate ELSE b.tax_rate END), 2)
                                                                 AS total`;

/** Lock the bid row for the duration of a mutation (the composer's lesson:
 *  two office keyboards on one document is the normal condition). */
async function lockBid(em: { query: (sql: string, p?: unknown[]) => Promise<unknown[]> },
                       id: number): Promise<{ status: string; invoice_id: number | null } | null> {
  const rows = (await em.query(
    `SELECT status::text AS status, invoice_id FROM septic_app.bids WHERE id = $1 FOR UPDATE`,
    [id],
  )) as Array<{ status: string; invoice_id: number | null }>;
  return rows.length ? rows[0] : null;
}

export const bidsController = {
  /** GET /api/bids[?status=&payer_id=] */
  list: async (req: Request, res: Response) => {
    try {
      const where: string[] = [];
      const params: unknown[] = [];
      if (req.query.status !== undefined) {
        const st = String(req.query.status);
        if (!['draft', 'approved', 'declined', 'invoiced'].includes(st)) {
          return res.status(400).json({ success: false,
            message: 'status must be draft, approved, declined or invoiced' });
        }
        params.push(st);
        where.push(`b.status = $${params.length}::septic_app.bid_status`);
      }
      if (req.query.payer_id !== undefined) {
        const pid = intParam(req.query.payer_id);
        if (!pid) return res.status(400).json({ success: false,
          message: 'payer_id must be a positive integer' });
        params.push(pid);
        where.push(`b.payer_id = $${params.length}`);
      }

      const rows = await AppDataSource.query(
        `SELECT b.id,
                to_char(b.bid_date, 'YYYY-MM-DD') AS bid_date,
                b.status::text                    AS status,
                case when coalesce(p.org_name, '') <> '' and trim(both from concat_ws(' ', p.first_name, p.last_name)) <> ''
                  then trim(both from concat_ws(' ', p.first_name, p.last_name)) || ' — ' || p.org_name
                  else coalesce(nullif(p.org_name, ''), trim(both from concat_ws(' ', p.first_name, p.last_name)))
                end AS payer_name,
                s0.site_address,
                to_char(b.approved_at, 'YYYY-MM-DD') AS approved_on,
                b.invoice_id,
                ${TOTALS.replace(/\bs\./g, 's.')}
           FROM septic_app.bids b
           JOIN septic_app.payers p ON p.id = b.payer_id
           JOIN septic_app.company_settings s ON s.id = 1
      LEFT JOIN septic_app.properties s0 ON s0.id = b.property_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY b.bid_date DESC, b.id DESC`,
        params,
      );
      return res.json({
        success: true,
        data: rows.map((r: any) => ({ ...r,
          subtotal: r.subtotal, tax_amount: r.tax_amount, total: r.total,
          tax_rate: String(r.eff_tax_rate), })),
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Bid list failed',
        error: internalError(error) });
    }
  },

  /**
   * Load a bid and its lines. A function, not the handler: `create`, `approve`
   * and `decline` all want the fresh document in the body, and the first build
   * of this got it by calling the handler — which reads `req.params.id`, an
   * empty string on `POST /bids`, so the bid was inserted, the endpoint found
   * "id must be a positive integer" about its own request, and answered 400
   * over a row it had just created. Bodies that name a path parameter belong
   * behind a path parameter.
   */
  loadDetail: async (id: number): Promise<Record<string, unknown> | null> => {
    const [bid] = await AppDataSource.query(
      `SELECT b.id,
              to_char(b.bid_date, 'YYYY-MM-DD')               AS bid_date,
              b.status::text                                  AS status,
              b.payer_id, b.property_id, b.notes, b.decline_note,
              b.tax_rate::text                                AS bid_tax_rate,
              b.invoice_id,
              to_char(b.approved_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS approved_at,
              to_char(b.declined_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS declined_at,
              (SELECT concat_ws(' ', u.first_name, u.last_name)
                 FROM septic_app.users u WHERE u.id = b.approved_by) AS approved_by_name,
              case when coalesce(p.org_name, '') <> '' and trim(both from concat_ws(' ', p.first_name, p.last_name)) <> ''
                  then trim(both from concat_ws(' ', p.first_name, p.last_name)) || ' — ' || p.org_name
                  else coalesce(nullif(p.org_name, ''), trim(both from concat_ws(' ', p.first_name, p.last_name)))
                end AS payer_name,
              p.mailing_address, p.mailing_city, p.mailing_state, p.mailing_zip,
              s0.site_address, s0.site_city, s0.site_state, s0.site_zip,
              ${TOTALS}
         FROM septic_app.bids b
         JOIN septic_app.payers p ON p.id = b.payer_id
         JOIN septic_app.company_settings s ON s.id = 1
    LEFT JOIN septic_app.properties s0 ON s0.id = b.property_id
        WHERE b.id = $1`,
      [id],
    );
    if (!bid) return null;
    const lines = await AppDataSource.query(
      `SELECT l.id, l.bid_item_id, bi.name AS item_name,
              l.description, l.unit,
              l.unit_price::text AS unit_price, l.quantity::text AS quantity,
              l.line_total::text AS line_total, l.sequence_no
         FROM septic_app.bid_lines l
    LEFT JOIN septic_app.bid_items bi ON bi.id = l.bid_item_id
        WHERE l.bid_id = $1
        ORDER BY l.sequence_no`,
      [id],
    );
    return { ...bid, lines };
  },

  /** GET /api/bids/:id — the bid, its lines, and the payer's mailing block.
   *  One request per document (BIL-08's rule): the print view must not be able
   *  to fail between the money half and the address half. */
  detail: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      const bid = await bidsController.loadDetail(id);
      if (!bid) {
        return res.status(404).json({ success: false, message: `No bid has id ${id}.` });
      }
      return res.json({ success: true, data: bid });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Bid detail failed',
        error: internalError(error) });
    }
  },

  /**
   * POST /api/bids  { payer_id, property_id?, notes? }
   *
   * A document is addressed to someone: the payer must exist (SCH-12's form is
   * the answer when the search finds nobody), and `bid_date` is the server's
   * business today — a client-supplied date is refused by name, because P10's
   * 635-day gap between the fixture and the wall clock is exactly what a
   * "hand me a dated bid" bug looks like.
   */
  create: async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      for (const owned of ['id', 'bid_date', 'status', 'tax_rate', 'approved_by',
                           'approved_at', 'declined_at', 'decline_note', 'invoice_id']) {
        if (body[owned] !== undefined) {
          return res.status(400).json({ success: false,
            message: `${owned} is the server's to set. Nothing was created.` });
        }
      }
      const payerId = intParam(body.payer_id);
      if (!payerId) {
        return res.status(400).json({ success: false,
          message: 'payer_id is required — a bid is a document addressed to somebody' });
      }
      const [payer] = await AppDataSource.query(
        `SELECT id FROM septic_app.payers WHERE id = $1`, [payerId]);
      if (!payer) {
        return res.status(404).json({ success: false,
          message: `No payer has id ${payerId}. If the biller is new, add them `
            + `from the biller form first (Settings -> biller form).` });
      }
      let propertyId: number | null = null;
      if (body.property_id !== undefined && body.property_id !== null) {
        propertyId = intParam(body.property_id);
        if (!propertyId) {
          return res.status(400).json({ success: false,
            message: 'property_id must be a positive integer' });
        }
        const [site] = await AppDataSource.query(
          `SELECT id FROM septic_app.properties WHERE id = $1`, [propertyId]);
        if (!site) {
          return res.status(404).json({ success: false, message: `No site has id ${propertyId}.` });
        }
      }
      let notes: string | null = null;
      if (body.notes !== undefined && body.notes !== null) {
        if (typeof body.notes !== 'string') {
          return res.status(400).json({ success: false, message: 'notes must be text' });
        }
        notes = body.notes.trim() || null;
      }

      // CTE so the new id comes back in rows[] shape, like every other read.
      const [{ newId }] = await AppDataSource.query(
        `WITH i AS (
             INSERT INTO septic_app.bids (payer_id, property_id, notes)
             VALUES ($1, $2, $3)
             RETURNING id
         )
         SELECT id AS "newId" FROM i`,
        [payerId, propertyId, notes],
      );
      // 201, with the full document as the body: the screen that just made a
      // draft should land on the draft, not on an id it has to re-fetch.
      const fresh = await bidsController.loadDetail(Number(newId));
      return res.status(201).json({ success: true, data: fresh });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Bid create failed',
        error: internalError(error) });
    }
  },

  /**
   * POST /api/bids/:id/lines  { bid_item_id, quantity } | { description, unit, unit_price, quantity }
   *
   * Exactly one source: an item to copy from, or a one-off line described in
   * the clerk's own words ("haul the old pad away"). Both is a contradiction —
   * BIL-10 says the copy is of *that moment*, so which price loses matters.
   */
  addLine: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      const body = req.body ?? {};
      for (const owned of ['id', 'bid_id', 'sequence_no', 'line_total']) {
        if (body[owned] !== undefined) {
          return res.status(400).json({ success: false,
            message: `${owned} is the server's to set. Nothing was added.` });
        }
      }
      const q = qty(body.quantity);
      if (!q) {
        return res.status(400).json({ success: false,
          message: 'quantity is required as a positive number with at most 2 decimals (3, 100, 2.5)' });
      }
      const hasItem = body.bid_item_id !== undefined && body.bid_item_id !== null;
      const hasFree = body.description !== undefined || body.unit !== undefined
        || body.unit_price !== undefined;
      if (hasItem && hasFree) {
        return res.status(400).json({ success: false,
          message: 'A line either copies a price-list item (bid_item_id + quantity) '
            + 'or is a one-off line (description + unit + unit_price + quantity) — not both.' });
      }

      const outcome = await AppDataSource.transaction(async (em) => {
        const bid = await lockBid(em, id);
        if (!bid) return { kind: 'no-bid' } as const;
        if (bid.status !== 'draft') {
          return { kind: 'sealed', ...statusRefusal(id, bid.status, bid.invoice_id) } as const;
        }

        let description: string, unit: string, price: string, itemId: number | null = null;
        if (hasItem) {
          itemId = intParam(body.bid_item_id);
          if (!itemId) return { kind: 'bad', message: 'bid_item_id must be a positive integer' } as const;
          const [item] = (await em.query(
            `SELECT name, unit, unit_price::text AS unit_price, is_active
               FROM septic_app.bid_items WHERE id = $1`, [itemId])) as any[];
          if (!item) {
            return { kind: 'bad',
              message: `No price-list item has id ${itemId}. Retired items can still be `
                + `quoted by id — but this one never existed.` } as const;
          }
          description = item.name; unit = item.unit; price = item.unit_price;
        } else {
          description = text(body.description, 255) ?? '';
          unit = text(body.unit, 20) ?? '';
          const p = Number(String(body.unit_price ?? '').trim());
          if (!description) {
            return { kind: 'bad',
              message: 'description is required for a one-off line (what the customer asked for)' } as const;
          }
          if (!unit) {
            return { kind: 'bad', message: 'unit is required — a price per *something*' } as const;
          }
          if (!Number.isFinite(p) || p < 0 || p >= 10000000) {
            return { kind: 'bad', message: 'unit_price must be a number from 0 up to 10,000,000' } as const;
          }
          price = p.toFixed(2);
        }
        if (Number(price) * Number(q) >= 10000000) {
          return { kind: 'bad',
            message: `That line would total ${price} × ${q} — at or above the 10,000,000 `
              + `ceiling a single line may carry. Nothing was added.` } as const;
        }

        const [line] = (await em.query(
          `INSERT INTO septic_app.bid_lines
             (bid_id, bid_item_id, description, unit, unit_price, quantity, sequence_no)
           SELECT $1, $2, $3, $4, $5::numeric(10,2), $6::numeric(8,2),
                  COALESCE((SELECT max(sequence_no) FROM septic_app.bid_lines
                             WHERE bid_id = $1), 0) + 1
           RETURNING id, bid_item_id, description, unit,
                     unit_price::text AS unit_price, quantity::text AS quantity,
                     line_total::text AS line_total, sequence_no`,
          [id, itemId, description, unit, price, q],
        )) as any[];
        if (!line) throw new Error('bid line insert returned no row');
        return { kind: 'added', line } as const;
      });

      if (outcome.kind === 'added') {
        return res.status(201).json({ success: true, data: outcome.line });
      }
      if (outcome.kind === 'no-bid') {
        return res.status(404).json({ success: false, message: `No bid has id ${id}.` });
      }
      if (outcome.kind === 'bad') {
        return res.status(400).json({ success: false, message: outcome.message });
      }
      return res.status(409).json({ success: false, message: outcome.message });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Add bid line failed',
        error: internalError(error) });
    }
  },

  /**
   * PATCH /api/bids/:id/lines/:lineId  { description?, unit?, quantity?, unit_price? }
   *
   * Drafts are where revision happens — which is what makes the signature
   * safe. `bid_item_id` is not editable: provenance is a fact about the moment
   * the line was added, and re-pointing it would rewrite that moment.
   */
  updateLine: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      const lineId = intParam(req.params.lineId);
      if (!id || !lineId) {
        return res.status(400).json({ success: false,
          message: 'id and lineId must be positive integers' });
      }
      const body = req.body ?? {};
      if (body.bid_item_id !== undefined || body.bid_id !== undefined
        || body.line_total !== undefined || body.sequence_no !== undefined) {
        return res.status(400).json({ success: false,
          message: 'bid_item_id, bid_id, sequence_no and line_total are the server\'s to set. '
            + 'To quote a different item, remove this line and add the other one.' });
      }

      const outcome = await AppDataSource.transaction(async (em) => {
        const bid = await lockBid(em, id);
        if (!bid) return { kind: 'no-bid' } as const;
        if (bid.status !== 'draft') {
          return { kind: 'sealed', ...statusRefusal(id, bid.status, bid.invoice_id) } as const;
        }
        const [line] = (await em.query(
          `SELECT description, unit, unit_price::text AS unit_price, quantity::text AS quantity
             FROM septic_app.bid_lines WHERE id = $1 AND bid_id = $2`,
          [lineId, id])) as any[];
        if (!line) {
          return { kind: 'no-line' } as const;
        }

        const sets: string[] = [];
        const params: unknown[] = [];
        const add = (col: string, val: unknown) => {
          params.push(val); sets.push(`${col} = $${params.length}::${col === 'unit_price' || col === 'quantity' ? 'numeric' : 'varchar'}`);
        };
        if (body.description !== undefined) {
          const d = text(body.description, 255);
          if (!d) return { kind: 'bad', message: 'description must be 1–255 characters' } as const;
          add('description', d);
        }
        if (body.unit !== undefined) {
          const u = text(body.unit, 20);
          if (!u) return { kind: 'bad', message: 'unit must be 1–20 characters' } as const;
          add('unit', u);
        }
        const price = body.unit_price === undefined
          ? line.unit_price
          : (() => { const p = Number(String(body.unit_price).trim());
            return Number.isFinite(p) && p >= 0 && p < 10000000 ? p.toFixed(2) : null; })();
        if (price === null) {
          return { kind: 'bad', message: 'unit_price must be a number from 0 up to 10,000,000' } as const;
        }
        const quantity = body.quantity === undefined ? line.quantity : qty(body.quantity);
        if (quantity === null) {
          return { kind: 'bad',
            message: 'quantity must be a positive number with at most 2 decimals' } as const;
        }
        if (body.unit_price !== undefined) add('unit_price', price);
        if (body.quantity !== undefined) add('quantity', quantity);
        if (!sets.length) {
          return { kind: 'bad',
            message: 'Nothing to change — send description, unit, quantity and/or unit_price' } as const;
        }
        if (Number(price) * Number(quantity) >= 10000000) {
          return { kind: 'bad',
            message: `That line would total ${price} × ${quantity} — at or above the 10,000,000 `
              + `ceiling a single line may carry. Nothing was changed.` } as const;
        }

        // UPDATE inside a CTE, read back with a plain SELECT: UPDATE...RETURNING
        // answers [rows, rowCount] through this driver while every SELECT-shaped
        // read answers rows[] — one shape that never changes beats destructuring
        // that depends on which verb you used.
        const [updated] = (await em.query(
          `WITH u AS (
               UPDATE septic_app.bid_lines
                  SET ${sets.join(', ')}
                WHERE id = $${params.length + 1} AND bid_id = $${params.length + 2}
                RETURNING id, bid_item_id, description, unit,
                          unit_price, quantity, line_total, sequence_no
           )
           SELECT id, bid_item_id, description, unit,
                  unit_price::text AS unit_price, quantity::text AS quantity,
                  line_total::text AS line_total, sequence_no
             FROM u`,
          [...params, lineId, id],
        )) as any[];
        return { kind: 'edited', line: updated } as const;
      });

      if (outcome.kind === 'edited') return res.json({ success: true, data: outcome.line });
      if (outcome.kind === 'no-bid') {
        return res.status(404).json({ success: false, message: `No bid has id ${id}.` });
      }
      if (outcome.kind === 'no-line') {
        return res.status(404).json({ success: false,
          message: `No bid line has id ${lineId} on bid ${id}.` });
      }
      if (outcome.kind === 'bad') {
        return res.status(400).json({ success: false, message: outcome.message });
      }
      return res.status(409).json({ success: false, message: outcome.message });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Bid line update failed',
        error: internalError(error) });
    }
  },

  /** DELETE /api/bids/:id/lines/:lineId — draft only; a signed line is history. */
  removeLine: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      const lineId = intParam(req.params.lineId);
      if (!id || !lineId) {
        return res.status(400).json({ success: false,
          message: 'id and lineId must be positive integers' });
      }

      const outcome = await AppDataSource.transaction(async (em) => {
        const bid = await lockBid(em, id);
        if (!bid) return { kind: 'no-bid' } as const;
        if (bid.status !== 'draft') {
          return { kind: 'sealed', ...statusRefusal(id, bid.status, bid.invoice_id) } as const;
        }
        const [gone] = await em.query(
          `WITH d AS (
               DELETE FROM septic_app.bid_lines WHERE id = $1 AND bid_id = $2 RETURNING id
           )
           SELECT id FROM d`,
          [lineId, id],
        );
        return gone ? { kind: 'removed' } as const : { kind: 'no-line' } as const;
      });

      if (outcome.kind === 'removed') {
        return res.json({ success: true, data: { removed: true } });
      }
      if (outcome.kind === 'no-bid') {
        return res.status(404).json({ success: false, message: `No bid has id ${id}.` });
      }
      if (outcome.kind === 'no-line') {
        return res.status(404).json({ success: false,
          message: `No bid line has id ${lineId} on bid ${id}.` });
      }
      return res.status(409).json({ success: false, message: outcome.message });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Remove bid line failed',
        error: internalError(error) });
    }
  },

  /**
   * POST /api/bids/:id/approve
   *
   * The signature. Who is read from the token (a body that names `approved_by`
   * is refused by name — an approval someone else typed in is not an approval);
   * when is the server clock; the tax rate is copied from the one-row settings
   * table at this instant (BIL-16: after this statement the bid's tax moves for
   * no reason short of a new bid). An empty bid cannot be approved — a document
   * with no lines is not a document, the rule that guards publishing a route
   * with no stops, found again in a paper world.
   */
  approve: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      const body = req.body ?? {};
      for (const owned of ['approved_by', 'approved_at', 'tax_rate', 'status']) {
        if (body[owned] !== undefined) {
          return res.status(400).json({ success: false,
            message: `${owned} is stamped by the server, not sent by the caller. Nothing was approved.` });
        }
      }

      const outcome = await AppDataSource.transaction(async (em) => {
        const bid = await lockBid(em, id);
        if (!bid) return { kind: 'no-bid' } as const;
        if (bid.status !== 'draft') {
          return { kind: 'sealed', ...statusRefusal(id, bid.status, bid.invoice_id) } as const;
        }
        const [{ n }] = (await em.query(
          `SELECT count(*)::int AS n FROM septic_app.bid_lines WHERE bid_id = $1`, [id])) as any[];
        if (n === 0) {
          return { kind: 'empty' } as const;
        }
        const [{ rate }] = (await em.query(
          `SELECT sales_tax_rate AS rate FROM septic_app.company_settings WHERE id = 1`)) as any[];
        await em.query(
          `UPDATE septic_app.bids
              SET status = 'approved', approved_by = $2, approved_at = now(),
                  tax_rate = $3, updated_at = now()
            WHERE id = $1`,
          [id, (req.user as { userId: number }).userId, rate],
        );
        return { kind: 'approved' } as const;
      });

      if (outcome.kind === 'approved') {
        const fresh = await bidsController.loadDetail(id);
        return res.json({ success: true, data: fresh });
      }
      if (outcome.kind === 'no-bid') {
        return res.status(404).json({ success: false, message: `No bid has id ${id}.` });
      }
      if (outcome.kind === 'empty') {
        return res.status(409).json({ success: false,
          message: `A bid with no lines is not a document. Add a line first (bid ${id}).` });
      }
      return res.status(409).json({ success: false, message: outcome.message });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Bid approve failed',
        error: internalError(error) });
    }
  },

  /**
   * POST /api/bids/:id/decline  { note? }
   *
   * Declining is terminal, and an approved bid cannot be declined — the
   * customer said yes, the paperwork now runs the other way: voiding or
   * adjusting what got invoiced is BIL-05's job, not a re-decision.
   */
  decline: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      let note: string | null = null;
      if (req.body?.note !== undefined && req.body?.note !== null) {
        if (typeof req.body.note !== 'string') {
          return res.status(400).json({ success: false, message: 'note must be text' });
        }
        note = req.body.note.trim() || null;
      }

      const outcome = await AppDataSource.transaction(async (em) => {
        const bid = await lockBid(em, id);
        if (!bid) return { kind: 'no-bid' } as const;
        if (bid.status !== 'draft') {
          return { kind: 'sealed', ...statusRefusal(id, bid.status, bid.invoice_id) } as const;
        }
        await em.query(
          `UPDATE septic_app.bids
              SET status = 'declined', declined_at = now(), decline_note = $2, updated_at = now()
            WHERE id = $1`,
          [id, note],
        );
        return { kind: 'declined' } as const;
      });

      if (outcome.kind === 'declined') {
        const fresh = await bidsController.loadDetail(id);
        return res.json({ success: true, data: fresh });
      }
      if (outcome.kind === 'no-bid') {
        return res.status(404).json({ success: false, message: `No bid has id ${id}.` });
      }
      return res.status(409).json({ success: false,
        message: (outcome as { message?: string }).message
          ?? `Bid ${id} is no longer a draft. Nothing was declined.` });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Bid decline failed',
        error: internalError(error) });
    }
  },

  /**
   * POST /api/bids/:id/convert
   *
   * BIL-13: header, lines, and the bid's invoice_id in one transaction — so a
   * refusal anywhere leaves no half-document behind, and the double-clicked
   * Convert button (the same twice, `Promise.all`, asserted in the suite)
   * serializes on the bid's row lock into one 201 and one 409 that names the
   * invoice. The money is SQL's: subtotal SUMs the generated line totals, tax
   * is round(subtotal × the rate the signature froze) — never the rate of
   * today, which may have moved since the signature — and total is their sum.
   */
  convert: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'id must be a positive integer' });

      const outcome = await AppDataSource.transaction(async (em) => {
        const bid = await lockBid(em, id);
        if (!bid) return { kind: 'no-bid' } as const;
        if (bid.status === 'invoiced') {
          return { kind: 'sealed', ...statusRefusal(id, bid.status, bid.invoice_id) } as const;
        }
        if (bid.status !== 'approved') {
          return {
            kind: 'not-approved',
            message: bid.status === 'draft'
              ? `Only an approved bid becomes an invoice — approve it first (bid ${id} is draft).`
              : statusRefusal(id, bid.status, bid.invoice_id).message,
          } as const;
        }

        // Money arithmetic lives here, in SQL (BIL-04/BIL-11): the rate is the
        // bid's stamp, not the settings row — reading settings at conversion is
        // the mutation this file's whole tax story exists to prevent.
        const [head] = (await em.query(
          `SELECT b.payer_id, b.property_id, b.tax_rate::text AS tax_rate,
                  COALESCE((SELECT SUM(l.line_total) FROM septic_app.bid_lines l
                             WHERE l.bid_id = b.id), 0)::text                    AS subtotal,
                  ROUND(COALESCE((SELECT SUM(l.line_total) FROM septic_app.bid_lines l
                                   WHERE l.bid_id = b.id), 0) * b.tax_rate, 2)::text AS tax_amount,
                  (COALESCE((SELECT SUM(l.line_total) FROM septic_app.bid_lines l
                              WHERE l.bid_id = b.id), 0)
                   + ROUND(COALESCE((SELECT SUM(l.line_total) FROM septic_app.bid_lines l
                                      WHERE l.bid_id = b.id), 0) * b.tax_rate, 2))::text AS total
             FROM septic_app.bids b WHERE b.id = $1`,
          [id],
        )) as any[];

        const [invoice] = (await em.query(
          `WITH i AS (
               INSERT INTO septic_app.invoices
                 (payer_id, property_id, invoice_date, subtotal, tax_rate, tax_amount, total)
               VALUES ($1, $2, septic_app.business_today(), $3::numeric, $4::numeric,
                       $5::numeric, $6::numeric)
               RETURNING id
           )
           SELECT id FROM i`,
          [head.payer_id, head.property_id, head.subtotal, head.tax_rate,
           head.tax_amount, head.total],
        )) as any[];

        await em.query(
          `INSERT INTO septic_app.invoice_lines
             (invoice_id, bid_line_id, description, quantity, unit_price, amount)
           SELECT $1, l.id, l.description, l.quantity, l.unit_price, l.line_total
             FROM septic_app.bid_lines l
            WHERE l.bid_id = $2
            ORDER BY l.sequence_no`,
          [invoice.id, id],
        );
        await em.query(
          `UPDATE septic_app.bids
              SET status = 'invoiced', invoice_id = $2, updated_at = now()
            WHERE id = $1`,
          [id, invoice.id],
        );
        return { kind: 'converted', invoiceId: Number(invoice.id),
          subtotal: head.subtotal, tax_amount: head.tax_amount,
          total: head.total } as const;
      });

      if (outcome.kind === 'converted') {
        return res.status(201).json({ success: true, data: {
          bid_id: id, invoice_id: outcome.invoiceId,
          subtotal: outcome.subtotal, tax_amount: outcome.tax_amount, total: outcome.total,
        } });
      }
      if (outcome.kind === 'no-bid') {
        return res.status(404).json({ success: false, message: `No bid has id ${id}.` });
      }
      return res.status(409).json({ success: false,
        message: (outcome as { message: string }).message });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Bid convert failed',
        error: internalError(error) });
    }
  },
};
