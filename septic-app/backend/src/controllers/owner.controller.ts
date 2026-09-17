import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';

function intParam(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

/**
 * Payer reassignment (SCH-06) — the write the legacy system could not do.
 *
 * Legacy had one owner column, so a sale meant UPDATE: the previous owner
 * vanished and the invoices already sent to them described nobody. The
 * `property_ownerships` table exists precisely so an ownership change is an
 * event with two rows instead of an overwrite with one: close the open row
 * (that is all it gets — its start date and its notes are history and history
 * is not edited), and open a new one.
 *
 * `ownership_end` of the closed row is set to the `ownership_start` of the new
 * one, never `ownership_start - 1 day`: two ranges that touch are the honest
 * story (the paperwork transferred on the day itself), and a one-day gap
 * invented at midnight is a fiction nobody can audit against anything.
 *
 * The rule "one current owner per site" is the partial unique index's job
 * (SCH-05); the transaction's job is to make the close-and-open atomic so the
 * index is never observed violated by a concurrent reader. The advisory lock on
 * the property is the SCH-08 pattern again: check-and-write are two statements
 * and a second clerk fits between them.
 */
export const assignPayer = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const propertyId = intParam(req.params.id);
    if (propertyId === null) {
      return res.status(404).json({ error: 'Property id must be a positive integer' });
    }
    const payerId = intParam(req.body?.payer_id);
    if (payerId === null) {
      return res.status(400).json({ error: 'payer_id must be a positive integer' });
    }
    const startRaw = req.body?.ownership_start;
    let start = '';
    if (startRaw === undefined || startRaw === null) {
      const [today] = await AppDataSource.query(
        `SELECT to_char(business_today(), 'YYYY-MM-DD') AS d`);
      start = today.d;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(startRaw))) {
      start = String(startRaw);
    } else {
      return res.status(400).json({ error: 'ownership_start must be YYYY-MM-DD' });
    }

    const outcome = await AppDataSource.transaction(async (em) => {
      const [prop] = await em.query(
        `SELECT 1 FROM septic_app.properties WHERE id = $1`, [propertyId],
      );
      if (!prop) return { kind: 'no-property' } as const;

      const [payer] = await em.query(
        `SELECT id FROM septic_app.payers WHERE id = $1`, [payerId],
      );
      if (!payer) return { kind: 'no-payer' } as const;

      await em.query(
        `SELECT pg_advisory_xact_lock(hashtext('owner:' || $1::text))`, [propertyId],
      );

      const [current] = (await em.query(
        `SELECT id, payer_id, ownership_start, is_primary
           FROM septic_app.property_ownerships
          WHERE property_id = $1 AND ownership_end IS NULL
            FOR UPDATE`,
        [propertyId],
      )) as any[];

      if (current && Number(current.payer_id) === payerId) {
        return { kind: 'same-payer' } as const;
      }

      if (current) {
        // The close touches exactly one column of the old row. Anything more and
        // this endpoint would be editing history — which is the whole crime SCH-06
        // exists to prevent the business from committing.
        const [closed] = (await em.query(
          `UPDATE septic_app.property_ownerships
              SET ownership_end = $2::date
            WHERE id = $1
            RETURNING id, payer_id, ownership_start, ownership_end, is_primary`,
          [current.id, start],
        )) as any[];
        void closed;
      }

      const [opened] = (await em.query(
        `INSERT INTO septic_app.property_ownerships
           (payer_id, property_id, is_primary, ownership_start, ownership_end, source)
         VALUES ($1, $2, $3, $4::date, NULL, 'app')
         RETURNING id, payer_id, property_id, is_primary, ownership_start, ownership_end, source`,
        [payerId, propertyId, current ? current.is_primary : true, start],
      )) as any[];

      return { kind: 'written', opened, closedId: current ? Number(current.id) : null } as const;
    });

    if (outcome.kind === 'no-property') {
      return res.status(404).json({ error: 'Property not found' });
    }
    if (outcome.kind === 'no-payer') {
      return res.status(404).json({ error: 'Payer not found' });
    }
    if (outcome.kind === 'same-payer') {
      return res.status(409).json({
        error: 'That payer already owns this site. Reassigning a property to its current owner is a no-op pretending to be an event.',
      });
    }

    res.status(201).json({
      ownership: outcome.opened,
      closed_ownership_id: outcome.closedId,
    });
  } catch (error) {
    res.status(500).json({ error: internalError(error) });
  }
};

/**
 * The ownership history of one site (the counterpart to the reassignment).
 *
 * Ordered newest-open-first: the current owner is the fact people ask for, and
 * the rows beneath it are the paper trail SCH-06 exists to keep. `current` is
 * derived exactly the way SCH-05's partial index derives it — the open row is
 * the one whose end is NULL — because a screen that decided "current" with its
 * own rule would be a second rule to keep in sync, and the reason the index
 * exists is that the first rule drifted.
 */
export const listOwners = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const propertyId = intParam(req.params.id);
    if (propertyId === null) {
      return res.status(404).json({ error: 'Property id must be a positive integer' });
    }
    const rows = await AppDataSource.query(
      `SELECT o.id, o.payer_id,
              case when coalesce(p.org_name, '') <> '' and trim(both from
                     concat_ws(' ', p.first_name, p.last_name)) <> ''
                   then trim(both from concat_ws(' ', p.first_name, p.last_name))
                        || ' — ' || p.org_name
                   else coalesce(nullif(p.org_name, ''), trim(both from
                     concat_ws(' ', p.first_name, p.last_name)))
                end AS payer_name,
              o.ownership_start, o.ownership_end, o.is_primary, o.source,
              o.ownership_end IS NULL AS current
         FROM septic_app.property_ownerships o
         JOIN septic_app.payers p ON p.id = o.payer_id
        WHERE o.property_id = $1
        ORDER BY o.ownership_end IS NULL DESC, o.ownership_start DESC, o.id DESC`,
      [propertyId],
    );
    return res.json({ success: true, data: rows });
  } catch (error) {
    return res.status(500).json({ error: internalError(error) });
  }
};
