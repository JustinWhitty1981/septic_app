import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';

/**
 * The master price list (BIL-09) — the half of the company's pricing that had
 * never been written down.
 *
 * Reference data, not history. Prices edit in place here because every value
 * anyone might later argue about was *copied* onto the bid line that used it
 * (BIL-10); versioning the catalog would protect a copy nobody needs to
 * protect and clutter the thing the office actually reads.
 *
 * There is no DELETE. `is_active=false` retires an item — the picker stops
 * offering it and the row survives, because a $300/hour plumber rate that once
 * existed is evidence of what the company charged, and a document that quotes
 * it keeps a `bid_item_id` that must keep resolving. The disposal-site table
 * learned this the same way: the office tidies a reference table by deciding
 * about its rows, not by erasing them.
 */

const intParam = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Whitespace-tidy and length-checked to the column, or null. */
const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max ? v.trim() : null;

/** Fields whose values the server owns — named in a refusal, never ignored. */
const NEVER = new Set(['id', 'created_at', 'updated_at']);

const neverField = (body: Record<string, unknown>): string | null => {
  for (const key of Object.keys(body ?? {})) {
    if (NEVER.has(key)) return key;
  }
  return null;
};

const SELECT = `
  SELECT id, name, unit, unit_price::text AS unit_price, is_active,
         to_char(created_at, 'YYYY-MM-DD') AS created_at
    FROM septic_app.bid_items`;

export const bidItemsController = {
  /** GET /api/bid-items[?include_retired=1] — open read; a price list is not a secret. */
  list: async (req: Request, res: Response) => {
    try {
      const retired = req.query.include_retired === '1';
      const rows = await AppDataSource.query(
        `${SELECT}
        ${retired ? '' : 'WHERE is_active'}
        ORDER BY is_active DESC, lower(name), id`,
      );
      return res.json({ success: true, data: rows });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Price list read failed',
        error: internalError(error) });
    }
  },

  /** POST /api/bid-items  { name, unit, unit_price } */
  create: async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const bad = neverField(body);
      if (bad) {
        return res.status(400).json({ success: false,
          message: `${bad} is the server's to set. Nothing was created.` });
      }
      const name = text(body.name, 120);
      if (!name) {
        return res.status(400).json({ success: false,
          message: 'name is required (the line the customer will read, up to 120 characters)' });
      }
      const unit = text(body.unit, 20);
      if (!unit) {
        return res.status(400).json({ success: false,
          message: 'unit is required — a price per *something* (hour, feet, each); '
            + 'a line item priced per nothing is how hours get billed as eaches' });
      }
      const price = Number(String(body.unit_price ?? '').trim());
      if (!Number.isFinite(price) || price < 0 || price >= 10000000) {
        return res.status(400).json({ success: false,
          message: 'unit_price is required as a non-negative number below 10,000,000' });
      }

      const [row] = await AppDataSource.query(
        `INSERT INTO septic_app.bid_items (name, unit, unit_price)
         VALUES ($1, $2, $3::numeric(10,2))
         RETURNING id, name, unit, unit_price::text AS unit_price, is_active,
                   to_char(created_at, 'YYYY-MM-DD') AS created_at`,
        [name, unit, price.toFixed(2)],
      );
      return res.status(201).json({ success: true, data: row });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Price-list item create failed',
        error: internalError(error) });
    }
  },

  /**
   * PATCH /api/bid-items/:id  { name?, unit?, unit_price?, is_active? }
   *
   * An edit is legitimate here — that is what makes the bid's copies the thing
   * worth trusting. `is_active=false` retires; nothing erases. The bid-line
   * copy test (T-BIL-09) is what makes "edit in place" safe rather than lucky.
   */
  update: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) {
        return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      }
      const body = req.body ?? {};
      const bad = neverField(body);
      if (bad) {
        return res.status(400).json({ success: false,
          message: `${bad} is the server's to set. Nothing was changed.` });
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      const add = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

      if (body.name !== undefined) {
        const name = text(body.name, 120);
        if (!name) return res.status(400).json({ success: false, message: 'name must be 1–120 characters' });
        add('name', name);
      }
      if (body.unit !== undefined) {
        const unit = text(body.unit, 20);
        if (!unit) return res.status(400).json({ success: false, message: 'unit must be 1–20 characters' });
        add('unit', unit);
      }
      if (body.unit_price !== undefined) {
        const price = Number(String(body.unit_price).trim());
        if (!Number.isFinite(price) || price < 0 || price >= 10000000) {
          return res.status(400).json({ success: false,
            message: 'unit_price must be a non-negative number below 10,000,000' });
        }
        add('unit_price', price.toFixed(2));
      }
      if (body.is_active !== undefined) {
        if (typeof body.is_active !== 'boolean') {
          return res.status(400).json({ success: false, message: 'is_active must be true or false' });
        }
        add('is_active', body.is_active);
      }
      if (!sets.length) {
        return res.status(400).json({ success: false,
          message: 'Nothing to change — send name, unit, unit_price and/or is_active' });
      }

      // UPDATE inside a CTE (see bids.controller): every read through this
      // driver gets one shape, rows[], no matter which verb wrote.
      const [row] = await AppDataSource.query(
        `WITH u AS (
             UPDATE septic_app.bid_items
                SET ${sets.join(', ')}, updated_at = now()
              WHERE id = $${params.length + 1}
             RETURNING id, name, unit, unit_price, is_active, created_at
         )
         SELECT id, name, unit, unit_price::text AS unit_price, is_active,
                to_char(created_at, 'YYYY-MM-DD') AS created_at
           FROM u`,
        [...params, id],
      );
      if (!row) {
        return res.status(404).json({ success: false,
          message: `No price-list item has id ${id}.` });
      }
      return res.json({ success: true, data: row });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Price-list item update failed',
        error: internalError(error) });
    }
  },
};
