import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';

/**
 * Payer search — the lookup the owner-reassignment screen needs, and no more.
 *
 * Bounded, ranked, and honest about the count: 7,572 payers do not fit a
 * dropdown, so the screen must search, and a search that returns "and 4,000
 * more" without a number teaches people to trust the first page. Ranking puts
 * the sites a payer currently owns on the row itself, because the person
 * reassigning a property is asking "is this the right customer?" and the most
 * disambiguating fact is what else they already own.
 *
 * There is no POST here on purpose. A payer is created when the paperwork is
 * right, which is an office decision with a form behind it, not a side effect
 * of typing into a reassignment box — the 1,047 legacy rows include what
 * happens when that discipline is missing.
 */
export const searchPayers = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length > 0 && q.length < 2) {
      return res.status(400).json({ error: 'q must be at least 2 characters' });
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);

    const rows = await AppDataSource.query(
      `SELECT p.id,
              case when coalesce(p.org_name, '') <> '' and trim(both from concat_ws(' ', p.first_name, p.last_name)) <> ''
                  then trim(both from concat_ws(' ', p.first_name, p.last_name)) || ' — ' || p.org_name
                  else coalesce(nullif(p.org_name, ''), trim(both from concat_ws(' ', p.first_name, p.last_name)))
                end AS name,
              p.mailing_address, p.mailing_city, p.mailing_state, p.mailing_zip,
              p.legacy_billing_no,
              count(o.id) FILTER (WHERE o.ownership_end IS NULL)::int AS sites_owned
         FROM septic_app.payers p
         LEFT JOIN septic_app.property_ownerships o ON o.payer_id = p.id
        WHERE $1 = ''
           OR coalesce(p.org_name, '') ilike '%' || $1 || '%'
           OR concat_ws(' ', p.first_name, p.last_name) ilike '%' || $1 || '%'
           -- ...and the same person in the order the office actually types:
           -- 'Swanson, Jim', exactly as it sits on the paper in front of them.
           -- Comma-insensitive, because the comma is the ledger's convention,
           -- not part of anybody's name (a 'Swanson, Jim' query found nobody
           -- the day the ledger called a biller "None").
           OR concat_ws(' ', p.last_name, p.first_name)
              ilike '%' || translate($1, ',', '') || '%'
        GROUP BY p.id
        ORDER BY count(o.id) FILTER (WHERE o.ownership_end IS NULL) DESC, name
        LIMIT $2`,
      [q, limit],
    );
    return res.json({ success: true, data: rows });
  } catch (error) {
    return res.status(500).json({ error: internalError(error) });
  }
};

/**
 * Add a biller (SCH-12) — the form this file's comment predicted.
 *
 * "A payer is created when the paperwork is right, which is an office decision
 * with a form behind it, not a side effect of typing into a reassignment box."
 * The site-add flow made the paperwork real: a brand-new site arrives with a
 * free-text `payer_label` and no `payers` row, so the biller search had
 * nothing to select and the ownership event had nobody to name. The form is
 * now here, on its own endpoint, reached by an explicit button — typing into
 * search still creates nothing, which is the whole distinction.
 *
 * Deliberately absent:
 *   * `legacy_billing_no` — the legacy natural key. A new payer has an id;
 *     the legacy column is not a sequence to hand out.
 *   * duplicate refusal — two households named Whitty are real. The search's
 *     `sites_owned` ranking is the disambiguator this file already promised,
 *     and a UNIQUE on a name column would be the legacy app inventing facts
 *     about which same-named people are "really" the same one.
 *   * email/fax/extensions — SCH-07: a payer is a mailing address. The phone
 *     is taken because offices do collect one; nothing here pretends the row
 *     is a way to *reach* anybody.
 */
export const createPayer = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const editable = ['org_name', 'first_name', 'last_name', 'mailing_address',
      'mailing_city', 'mailing_state', 'mailing_zip', 'phone'];
    const unknown = Object.keys(body).filter((k) => !editable.includes(k));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown field "${unknown[0]}"` });
    }

    const text = (key: string, max: number): { value?: string | null; error?: string } => {
      if (body[key] === undefined || body[key] === null) return { value: null };
      if (typeof body[key] !== 'string') return { error: `${key} must be text` };
      const s = (body[key] as string).trim();
      if (s.length > max) return { error: `${key} is at most ${max} characters` };
      return { value: s === '' ? null : s };
    };

    const values: Record<string, string | null> = {};
    for (const [key, max] of [['org_name', 200], ['first_name', 100], ['last_name', 100],
      ['mailing_address', 255], ['mailing_city', 100], ['mailing_zip', 10],
      ['phone', 20]] as const) {
      const r = text(key, max);
      if (r.error) return res.status(400).json({ error: r.error });
      values[key] = r.value!;
    }
    const state = text('mailing_state', 2);
    if (state.error) return res.status(400).json({ error: state.error });
    if (state.value !== null && !/^[A-Za-z]{2}$/.test(state.value)) {
      return res.status(400).json({ error: 'mailing_state must be a two-letter state, e.g. WI' });
    }
    values.mailing_state = state.value ? state.value.toUpperCase() : null;

    // The name rule the search already encodes: a payer is an organisation or
    // a person, and it must be one of them. A row with no name is an invoice
    // addressed to nobody, and the 1,047 legacy rows already contain what
    // happens when that bar is not held.
    if (!values.org_name && !values.first_name && !values.last_name) {
      return res.status(400).json({
        error: 'A biller needs a name — an organization, or a first or last name',
      });
    }

    const cols = Object.keys(values);
    const params = cols.map((c) => values[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const created = await AppDataSource.query(
      `INSERT INTO septic_app.payers (${cols.join(', ')})
       VALUES (${placeholders})
       RETURNING id,
                 case when coalesce(org_name, '') <> '' and trim(both from concat_ws(' ', first_name, last_name)) <> ''
                  then trim(both from concat_ws(' ', first_name, last_name)) || ' — ' || org_name
                  else coalesce(nullif(org_name, ''), trim(both from concat_ws(' ', first_name, last_name)))
                end AS name,
                 mailing_address, mailing_city, mailing_state, mailing_zip, phone,
                 0::int AS sites_owned`,
      params,
    );
    return res.status(201).json({ success: true, data: created[0] });
  } catch (error) {
    return res.status(500).json({ error: internalError(error) });
  }
};
