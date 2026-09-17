import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';

/**
 * The one-row company settings (0027's table, BIL-16's rate).
 *
 * This file exists because a sales tax that lives in code is a sales tax that
 * changes with a deploy, and a state rate that changes with a deploy is how
 * every old system's tax column ended up full of 0. The office sets it in one
 * field; every bid screen reads it; approval stamps it onto documents (BIL-16)
 * so a rate change can never reach a signed price.
 *
 * The read is open to any authenticated user — a driver asked "what's our tax
 * rate?" on a job site is not doing anything wrong, and hiding a public
 * percentage behind a role gate buys nothing. The write is office-only: the
 * rate decides what customers are charged, and the 0027 comment's rule stands —
 * the guess is made once, by the office, in the open, and `updated_by` says who.
 */
export const settingsController = {
  /** GET /api/settings */
  get: async (_req: Request, res: Response) => {
    try {
      const [row] = await AppDataSource.query(
        `SELECT sales_tax_rate::text AS sales_tax_rate,
                payment_term_days::int AS payment_term_days,
                late_fee_rate_monthly::text AS late_fee_rate_monthly,
                company_name, logo_media_id::int AS logo_media_id,
                address, email, phone,
                to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at,
                (SELECT concat_ws(' ', u.first_name, u.last_name)
                   FROM septic_app.users u
                  WHERE u.id = company_settings.updated_by) AS updated_by
           FROM septic_app.company_settings WHERE id = 1`,
      );
      return res.json({ success: true, data: row });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Settings read failed',
        error: internalError(error) });
    }
  },

  /**
   * PATCH /api/settings/sales-tax  { sales_tax_rate }
   *
   * The value is a rate, and the CHECK that refuses `1` exists for a specific
   * hand: the one typing `5.5` into a decimal field. A percent typed as a rate
   * bills 550% of every job in the county — an error large enough that no
   * amount check catches and no customer pays twice. So the bounds are the
   * requirement (0 ≤ r < 1), the refusal message teaches the conversion, and
   * the UI does the ×100 so the field can mean what the clerk types.
   */
  setSalesTax: async (req: Request, res: Response) => {
    try {
      const raw = req.body?.sales_tax_rate;
      if (typeof raw !== 'string' && typeof raw !== 'number') {
        return res.status(400).json({ success: false,
          message: 'sales_tax_rate is required (a decimal rate: 0.055 for 5.5%)' });
      }
      const rate = Number(String(raw).trim());
      if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
        return res.status(400).json({ success: false,
          message: `sales_tax_rate must be a decimal rate from 0 up to (but not including) 1 — `
            + `5.5% is 0.055, not 5.5. Nothing was changed.` });
      }
      // Two decimal digits on a 5.4 rate is 0.1 hundredths of a percent apart;
      // beyond that, the invoice would round something nobody agreed to.
      if (!/^\d*(\.\d{1,4})?$/.test(String(raw).trim())) {
        return res.status(400).json({ success: false,
          message: 'sales_tax_rate accepts at most 4 decimal places (0.0555), nothing was changed' });
      }

      await AppDataSource.query(
        `UPDATE septic_app.company_settings
            SET sales_tax_rate = $1::numeric(5,4),
                updated_at = now(),
                updated_by = $2
          WHERE id = 1`,
        [rate.toFixed(4), (req.user as { userId: number }).userId],
      );
      const updated = await settingsController.get(req, res);
      return updated;
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Settings update failed',
        error: internalError(error) });
    }
  },

  /**
   * PATCH /api/settings/payment-terms  { payment_term_days, late_fee_rate_monthly }
   *
   * The invoice has to state, on its own face, when money is due and what
   * happens when it is late — so those are company facts, stored once beside
   * the tax rate, not retyped per document (which is the whole reason the rate
   * felt "temporary" from the bid screen). A day count is bounded so a fat
   * finger does not print "due in 3000 days"; the late rate is a monthly rate
   * (0.015 = 1.5%) and shares the tax field's <1 bound for the same reason —
   * a percent typed as a rate would print a 150% monthly penalty.
   */
  setPaymentTerms: async (req: Request, res: Response) => {
    try {
      const daysRaw = req.body?.payment_term_days;
      const lateRaw = req.body?.late_fee_rate_monthly;
      const days = Number(String(daysRaw ?? '').trim());
      const late = Number(String(lateRaw ?? '').trim());
      if (!Number.isInteger(days) || days < 0 || days > 365) {
        return res.status(400).json({ success: false,
          message: 'payment_term_days must be a whole number of days from 0 to 365 (e.g. 30). Nothing was changed.' });
      }
      if (!Number.isFinite(late) || late < 0 || late >= 1) {
        return res.status(400).json({ success: false,
          message: `late_fee_rate_monthly must be a decimal rate from 0 up to (but not including) 1 — `
            + `1.5% a month is 0.015, not 1.5. Nothing was changed.` });
      }
      if (!/^\d*(\.\d{1,4})?$/.test(String(lateRaw).trim())) {
        return res.status(400).json({ success: false,
          message: 'late_fee_rate_monthly accepts at most 4 decimal places (0.0150), nothing was changed' });
      }
      await AppDataSource.query(
        `UPDATE septic_app.company_settings
            SET payment_term_days = $1::int,
                late_fee_rate_monthly = $2::numeric(5,4),
                updated_at = now(),
                updated_by = $3
          WHERE id = 1`,
        [days, late.toFixed(4), (req.user as { userId: number }).userId],
      );
      return await settingsController.get(req, res);
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Settings update failed',
        error: internalError(error) });
    }
  },

  /**
   * PATCH /api/settings/company  { company_name?, logo_media_id?, address?,
   *                              email?, phone? }  (0037, the printed letterhead)
   *
   * The name, logo and contact block every invoice and bid carries. Same
   * doctrine as the other setters: a company-wide fact stored once, `updated_by`
   * naming who, and the documents reading the row instead of a string hardcoded
   * in a component — which is how the invoice and the bid ended up printing two
   * different names for the same company.
   *
   * The logo is a pointer into `media`, never bytes in a column (NF-04): the
   * upload rides the existing photo pipeline (`POST /api/media/upload`), and
   * this setter only accepts an id that names a live media row, refusing to
   * print a letterhead whose bytes are gone. An unknown key in the body is
   * refused by name — a field the caller invented must not read as the null
   * that clears a real one.
   */
  setCompany: async (req: Request, res: Response) => {
    try {
      const b = req.body ?? {};
      const TEXT_MAX: Record<string, number> = {
        company_name: 200, address: 300, email: 200, phone: 50,
      };
      const allowed = [...Object.keys(TEXT_MAX), 'logo_media_id'];
      const given = Object.keys(b);
      const unknown = given.filter((k) => !allowed.includes(k));
      if (unknown.length) {
        return res.status(400).json({ success: false,
          message: `Unrecognized field(s): ${unknown.join(', ')} — `
            + `this endpoint sets ${allowed.join(', ')}. Nothing was changed.` });
      }
      if (!given.length) {
        return res.status(400).json({ success: false,
          message: `Nothing to change: send at least one of ${allowed.join(', ')} `
            + `(null clears a field). Nothing was changed.` });
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      for (const field of ['company_name', 'address', 'email', 'phone'] as const) {
        if (!(field in b)) continue;
        const raw = b[field];
        if (raw !== null && typeof raw !== 'string') {
          return res.status(400).json({ success: false,
            message: `${field} must be a string or null (null clears it). Nothing was changed.` });
        }
        const value = typeof raw === 'string' ? raw.trim() : '';
        if (value.length > TEXT_MAX[field]) {
          return res.status(400).json({ success: false,
            message: `${field} is ${value.length} characters; the limit is ${TEXT_MAX[field]} — `
              + `it prints on every document the company owns. Nothing was changed.` });
        }
        if (field === 'company_name' && value === '') {
          return res.status(400).json({ success: false,
            message: 'company_name cannot be blank — every printed document is '
              + 'headed by it. Nothing was changed.' });
        }
        sets.push(`${field} = $${params.length + 1}`);
        params.push(value === '' ? null : value);
      }
      if ('logo_media_id' in b) {
        const raw = b.logo_media_id;
        if (raw === null) {
          sets.push('logo_media_id = NULL');
        } else {
          const id = Number(raw);
          if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false,
              message: 'logo_media_id must be the id of an uploaded image (or null to '
                + 'print no logo); upload it with POST /api/media/upload first. Nothing was changed.' });
          }
          const [media] = await AppDataSource.query(
            `SELECT 1 FROM septic_app.media WHERE id = $1 AND deleted_at IS NULL`, [id],
          );
          if (!media) {
            return res.status(404).json({ success: false,
              message: `No uploaded image has id ${id} — upload the logo with `
                + 'POST /api/media/upload and send the id it returns. Nothing was changed.' });
          }
          sets.push(`logo_media_id = $${params.length + 1}`);
          params.push(id);
        }
      }

      await AppDataSource.query(
        `UPDATE septic_app.company_settings
            SET ${sets.join(', ')}, updated_at = now(), updated_by = $${params.length + 1}
          WHERE id = 1`,
        [...params, (req.user as { userId: number }).userId],
      );
      return await settingsController.get(req, res);
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Settings update failed',
        error: internalError(error) });
    }
  },
};
