import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';

/**
 * Accounts receivable (BIL-07): who owes money, how much, and since when.
 *
 * Computed on every call, for the reason LED-02 learned twice over — a stored
 * tally drifts from its source and the drift is invisible until an audit. A
 * `balance_owed` column would be that mistake with money on it: the number a
 * collector dials out has to be re-derivable from receipts and invoices on the
 * day of the call, and here it is, always.
 *
 * What counts toward a payer's balance:
 *
 *  - totals of all non-void invoices, *including* adjustments and credits —
 *    the negative rows net against the positive ones, which is the whole
 *    design of BIL-05 paying off: the balance of an adjusted invoice is
 *    arithmetic, not memory;
 *  - minus every payment row ever taken (a payment against a later-voided
 *    invoice stays in `collected`, so such a payer can go negative — the
 *    `credit_balances` meta count exists because that anomaly should be
 *    visible, not silently filtered; it means someone owes *them*, or a void
 *    was applied to something already paid).
 *
 * `balance > 0` is the list's definition: a payer who owes nothing does not
 * appear. That is a filter, not a display rule — the receivables page is the
 * chase list, and the book (GET /invoices?payer_id=) is the drill-down that
 * answers "which invoice?".
 */
export const listReceivables = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const rows = await AppDataSource.query(
      `WITH billed AS (
           SELECT i.payer_id,
                  sum(i.total)                                    AS billed,
                  min(i.invoice_date) FILTER (
                    WHERE i.status::text IN ('open','partial')
                      AND i.total - i.amount_paid > 0
                  )                                               AS oldest_open,
                  count(*) FILTER (
                    WHERE i.status::text IN ('open','partial')
                      AND i.total - i.amount_paid > 0
                  )::int                                          AS open_invoices
             FROM septic_app.invoices i
            WHERE i.status::text <> 'void'
            GROUP BY 1
          ),
          collected AS (
           SELECT i.payer_id, sum(p.amount) AS collected
             FROM septic_app.payments p
             JOIN septic_app.invoices i ON i.id = p.invoice_id
            GROUP BY 1
          ),
          balances AS (
           SELECT p.id AS payer_id,
                  case when coalesce(p.org_name, '') <> '' and trim(both from concat_ws(' ', p.first_name, p.last_name)) <> ''
                  then trim(both from concat_ws(' ', p.first_name, p.last_name)) || ' — ' || p.org_name
                  else coalesce(nullif(p.org_name, ''), trim(both from concat_ws(' ', p.first_name, p.last_name)))
                end   AS payer_name,
                  b.billed, c.collected,
                  coalesce(b.billed, 0) - coalesce(c.collected, 0) AS balance,
                  b.oldest_open, b.open_invoices
             FROM septic_app.payers p
             LEFT JOIN billed b ON b.payer_id = p.id
             LEFT JOIN collected c ON c.payer_id = p.id
            WHERE coalesce(b.billed, 0) > 0 OR coalesce(c.collected, 0) > 0
          )
       SELECT payer_id, payer_name, billed, collected, balance,
              oldest_open, open_invoices
         FROM balances
        WHERE balance > 0
          AND ($1 = '' OR payer_name ilike '%' || $1 || '%')
        ORDER BY balance DESC, payer_name`,
      [q],
    );
    const [anomalies] = await AppDataSource.query(
      `WITH billed AS (
           SELECT i.payer_id, sum(i.total) AS billed
             FROM septic_app.invoices i
            WHERE i.status::text <> 'void' GROUP BY 1
          ),
          collected AS (
           SELECT i.payer_id, sum(p.amount) AS collected
             FROM septic_app.payments p JOIN septic_app.invoices i ON i.id = p.invoice_id
            GROUP BY 1
          )
       SELECT count(*) FILTER (
         WHERE coalesce(b.billed,0) - coalesce(c.collected,0) < 0)::int AS credit_balances
         FROM septic_app.payers p
         LEFT JOIN billed b ON b.payer_id = p.id
         LEFT JOIN collected c ON c.payer_id = p.id
        WHERE coalesce(b.billed,0) > 0 OR coalesce(c.collected,0) > 0`,
    );
    const totals = rows.reduce((acc: any, r: any) => ({
      balance: Number(acc.balance) + Number(r.balance),
    }), { balance: 0 });
    return res.json({
      success: true,
      data: rows,
      meta: { payers_owing: rows.length,
              total_receivable: totals.balance.toFixed(2),
              credit_balances: anomalies.credit_balances },
    });
  } catch (error) {
    return res.status(500).json({ error: internalError(error) });
  }
};
