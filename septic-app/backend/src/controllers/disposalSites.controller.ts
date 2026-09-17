import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';

const INT4_MAX = 2_147_483_647;

function intParam(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= INT4_MAX ? n : null;
}

/**
 * One SELECT whose shape never changes (the AppDataSource rule): the list
 * every role reads, the shape create/update return after writing, so no
 * caller assembles derived columns by hand and gets them subtly wrong.
 * `events_using` is what the ledger names per site — the office decides
 * deletions with it in view, and it costs the driver's Done dialog nothing.
 */
const SELECT_LIST =
  `SELECT d.id, d.name, d.dnr_permit_no, d.accepts_slurry,
          d.dnr_permit_no IS NOT NULL AS permitted,
          coalesce(u.n, 0)::int AS events_using,
          d.id = (SELECT default_disposal_site_id
                    FROM septic_app.company_settings WHERE id = 1) AS is_default
     FROM septic_app.disposal_sites d
     LEFT JOIN (SELECT disposal_site_id, count(*) AS n
                  FROM septic_app.service_events
                 GROUP BY disposal_site_id) u ON u.disposal_site_id = d.id`;

/**
 * The list of places waste is legally allowed to end up.
 *
 * This endpoint exists because the server requires `disposal_site_id` on every
 * `done` write (a service event without a site is not a compliance record, and
 * the state report is assembled downstream of it), and the only way a driver
 * could satisfy that rule was to *already know an id*. The UI asked for
 * gallons; the server demanded a site; the queued write died in the 400-drop
 * path and the driver watched a tap do nothing. An endpoint that returns the
 * vocabulary the next write will be judged against is not a convenience — it
 * is what makes the rule followable.
 *
 * The names are legacy free text and it shows (`Land`, `Slurrystore`, `spread
 * on his land` — DATA_MODEL on disposal sites). This endpoint does not
 * normalize, dedupe or editorialize: inventing tidy site names here would put
 * a guess between the truck's actual destination and the county's ledger.
 * The office owns tidying that table; the driver's list is whatever is true.
 *
 * Readable by every role, including `driver` — see `tests/office-gate.test.ts`
 * OPEN_READS. A driver who cannot fetch the list cannot lawfully finish a
 * stop, and an endpoint the enforcement depends on must be reachable by the
 * person doing the enforcing-with.
 */
export const disposalSitesController = {
  list: async (_req: Request, res: Response): Promise<void> => {
    try {
      const rows = await AppDataSource.query(`${SELECT_LIST} ORDER BY d.name`);
      res.json({ success: true, data: rows });
    } catch (error) {
      res.status(500).json({ error: internalError(error) });
    }
  },

  /**
   * Add a site to the vocabulary (LED-07).
   *
   * The names are free text on purpose — that is the legacy corpus talking
   * (`Land`, `Slurrystore`), and a normalizer here would put a guess between
   * the truck's destination and the county's ledger, which is exactly what the
   * list endpoint's comment has always refused to do. Tidying is the office's
   * editorial call; this endpoint is how the call gets made instead of a
   * psql session.
   *
   * `accepts_slurry` stays nullable: an office adding a site it has not asked
   * yet should record that it does not know, rather than have a form file a
   * false for a fact nobody checked.
   */
  create: async (req: Request, res: Response): Promise<void> => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const unknown = Object.keys(body).filter(
        (k) => !['name', 'dnr_permit_no', 'accepts_slurry'].includes(k),
      );
      if (unknown.length) {
        res.status(400).json({ error: `Unknown field "${unknown[0]}"` });
        return;
      }
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 160) {
        res.status(400).json({ error: 'name is required (1–160 characters)' });
        return;
      }
      if (body.dnr_permit_no !== undefined && body.dnr_permit_no !== null
          && typeof body.dnr_permit_no !== 'string') {
        res.status(400).json({ error: 'dnr_permit_no must be text' });
        return;
      }
      const permit = typeof body.dnr_permit_no === 'string' ? body.dnr_permit_no.trim() : '';
      if (permit.length > 40) {
        res.status(400).json({ error: 'dnr_permit_no is at most 40 characters' });
        return;
      }
      if (body.accepts_slurry !== undefined && body.accepts_slurry !== null
          && typeof body.accepts_slurry !== 'boolean') {
        res.status(400).json({ error: 'accepts_slurry must be true, false, or null' });
        return;
      }

      try {
        await AppDataSource.query(
          `INSERT INTO septic_app.disposal_sites (name, dnr_permit_no, accepts_slurry)
           VALUES ($1, nullif($2, ''), $3)`,
          [name, permit, body.accepts_slurry ?? null],
        );
      } catch (error: any) {
        if (error?.code === '23505') {
          res.status(409).json({ error: `A disposal site named "${name}" already exists.` });
          return;
        }
        throw error;
      }
      // Re-read in the shape every reader of this table already expects — one
      // SELECT whose shape never changes, rather than reconstructing the
      // derived columns from the values that went in.
      const rows = await AppDataSource.query(
        `${SELECT_LIST} WHERE d.name = $1`,
        [name],
      );
      res.status(201).json({ success: true, data: rows[0] });
    } catch (error) {
      res.status(500).json({ error: internalError(error) });
    }
  },

  /**
   * Rename or annotate a site (LED-07).
   *
   * This is an UPDATE of a row the ledger joins to, and it is allowed, because
   * the ledger's reference is the *id*, not the name: renaming `Slurrystore`
   * to `County Slurry Storage` corrects every county report that joins on
   * it, and touches no regulatory row. Had the events carried the name (as the
   * legacy app did), this endpoint would be history editing and would not
   * exist.
   *
   * Narrow UPDATE, per AUT-09's rule: only the columns the body named.
   */
  update: async (req: Request, res: Response): Promise<void> => {
    try {
      const id = intParam(req.params.id);
      if (id === null) {
        res.status(400).json({ error: 'id must be a positive integer' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const unknown = Object.keys(body).filter(
        (k) => !['name', 'dnr_permit_no', 'accepts_slurry'].includes(k),
      );
      if (unknown.length) {
        res.status(400).json({ error: `Unknown field "${unknown[0]}"` });
        return;
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      let renameTo = '';
      if (body.name !== undefined) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 160) {
          res.status(400).json({ error: 'name must be 1–160 characters' });
          return;
        }
        renameTo = name;
        params.push(name);
        sets.push(`name = $${params.length}`);
      }
      if (body.dnr_permit_no !== undefined) {
        if (body.dnr_permit_no !== null && typeof body.dnr_permit_no !== 'string') {
          res.status(400).json({ error: 'dnr_permit_no must be text or null' });
          return;
        }
        const permit = body.dnr_permit_no === null ? '' : (body.dnr_permit_no as string).trim();
        if (permit.length > 40) {
          res.status(400).json({ error: 'dnr_permit_no is at most 40 characters' });
          return;
        }
        params.push(permit || null);
        sets.push(`dnr_permit_no = $${params.length}`);
      }
      if (body.accepts_slurry !== undefined) {
        if (body.accepts_slurry !== null && typeof body.accepts_slurry !== 'boolean') {
          res.status(400).json({ error: 'accepts_slurry must be true, false, or null' });
          return;
        }
        params.push(body.accepts_slurry);
        sets.push(`accepts_slurry = $${params.length}`);
      }
      if (!sets.length) {
        res.status(400).json({
          error: 'No editable fields given. Send name, dnr_permit_no, or accepts_slurry.',
        });
        return;
      }

      params.push(id);
      let failed: any;
      let rows: unknown;
      try {
        rows = await AppDataSource.query(
          `UPDATE septic_app.disposal_sites
              SET ${sets.join(', ')}
            WHERE id = $${params.length}
            RETURNING id`,
          params,
        );
      } catch (error) {
        failed = error;
      }
      if (failed) {
        if (failed?.code === '23505') {
          res.status(409).json({ error: `A disposal site named "${renameTo}" already exists.` });
          return;
        }
        throw failed;
      }
      const [, rowCount] = rows as unknown as [unknown, number];
      if (!rowCount) {
        res.status(404).json({ error: `No disposal site has id ${id}.` });
        return;
      }
      const after = await AppDataSource.query(`${SELECT_LIST} WHERE d.id = $1`, [id]);
      res.json({ success: true, data: after[0] });
    } catch (error) {
      res.status(500).json({ error: internalError(error) });
    }
  },

  /**
   * Remove a never-named site (LED-07).
   *
   * There is a version of this endpoint that cascades, and it is the worst
   * idea in this file: `service_events.disposal_site_id` is RESTRICT (0023)
   * because pointing 2,965 regulatory events at nothing is not tidying, it is
   * erasing. So the rule the database already enforces is stated here in the
   * words the office needs — the name and the count — and the deletion only
   * happens while nothing names the row. A mis-keyed duplicate gets removed;
   * a site the trucks actually used gets renamed, merged by hand, or left
   * alone. History is never pointed away from what it recorded.
   *
   * The company default gets its own refusal: deleting it would leave
   * `company_settings` pointing at a row that is gone, and the DRV-20 rule is
   * that the default is a value someone chose — the choice has to move first.
   */
  remove: async (req: Request, res: Response): Promise<void> => {
    try {
      const id = intParam(req.params.id);
      if (id === null) {
        res.status(400).json({ error: 'id must be a positive integer' });
        return;
      }
      const [site] = await AppDataSource.query(
        `SELECT d.name,
                (SELECT count(*)::int FROM septic_app.service_events e
                  WHERE e.disposal_site_id = d.id) AS events_using,
                EXISTS (SELECT 1 FROM septic_app.company_settings s
                         WHERE s.id = 1 AND s.default_disposal_site_id = d.id) AS is_default
           FROM septic_app.disposal_sites d WHERE d.id = $1`,
        [id],
      );
      if (!site) {
        res.status(404).json({ error: `No disposal site has id ${id}.` });
        return;
      }
      if (site.events_using > 0) {
        res.status(409).json({
          error: `The ledger names "${site.name}" on ${site.events_using} events. `
               + 'History cannot be deleted — rename the site instead.',
        });
        return;
      }
      if (site.is_default) {
        res.status(409).json({
          error: `"${site.name}" is the company default. Move the default before deleting it.`,
        });
        return;
      }
      try {
        const deleted = await AppDataSource.query(
          `DELETE FROM septic_app.disposal_sites WHERE id = $1`,
          [id],
        );
        const [, rowCount] = deleted as unknown as [unknown, number];
        if (!rowCount) {
          res.status(404).json({ error: `No disposal site has id ${id}.` });
          return;
        }
      } catch (error: any) {
        // The pre-check and the delete are not one statement; a completion
        // landing in between hits RESTRICT. Same refusal, same words.
        if (error?.code === '23503') {
          res.status(409).json({
            error: `"${site.name}" is named by a record written a moment ago. It cannot be deleted.`,
          });
          return;
        }
        throw error;
      }
      res.json({ success: true, data: { deleted: id } });
    } catch (error) {
      res.status(500).json({ error: internalError(error) });
    }
  },

  /**
   * Move the company default (DRV-20). Office role, because it is an
   * operational decision about where the trucks go — and validation is
   * two-tone on purpose: a nonexistent id is refused by naming it (the
   * phrasing NF-11 requires), and a NULL id is refused outright. A company
   * with no default at all is the bug this table exists to end; the column
   * stays NOT NULL *through this endpoint*, even though the seed migration
   * could not say so before it knew a site named ZSS existed.
   */
  setDefault: async (req: Request, res: Response): Promise<void> => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const siteId = Number(body.site_id);
      if (!Number.isInteger(siteId) || siteId <= 0) {
        res.status(400).json({ error: 'site_id must be a positive integer' });
        return;
      }
      const updated = await AppDataSource.query(
        `UPDATE septic_app.company_settings
            SET default_disposal_site_id = $1, updated_at = now(), updated_by = $2
          WHERE id = 1
            AND EXISTS (SELECT 1 FROM septic_app.disposal_sites WHERE id = $1)`,
        [siteId, Number.isInteger(req.user?.userId) ? req.user?.userId : null],
      );
      const [, rowCount] = updated as unknown as [unknown, number];
      if (!rowCount) {
        res.status(400).json({ error: `No disposal site has id ${siteId}.` });
        return;
      }
      res.json({ success: true, data: { default_disposal_site_id: siteId } });
    } catch (error) {
      res.status(500).json({ error: internalError(error) });
    }
  },
};
