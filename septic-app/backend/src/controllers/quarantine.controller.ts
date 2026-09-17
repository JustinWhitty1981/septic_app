import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';

/**
 * The quarantine queue: source rows the migration refused to interpret.
 *
 * DATA_MODEL §9 calls this the most reviewable table in the schema, and the only place a
 * human can still correct the migration. 3,876 rows sit here and none has been looked at.
 * Reading them in a psql session is not a realistic way to drain that, so this file makes
 * the pile navigable.
 *
 * Three things shape every query below.
 *
 * 1. `reason` is not an enum and cannot be offered as one.
 *
 *    The `orphan_line_*` codes carry the invoice number inside the string —
 *    "`orphan_line_in_gap: invoice 15886`" — so 3,876 rows produce 2,944 distinct values.
 *    A dropdown built from `SELECT DISTINCT reason` would hand the office 2,944 options,
 *    2,936 of which appear exactly once. Everything here groups on
 *    `split_part(reason, ':', 1)` first, which is the nine families the codes fall into:
 *
 *      | Family                               | Rows | Source            |
 *      |--------------------------------------|------|-------------------|
 *      | `orphan_line_below_window`           | 1709 | tblInvoiceAmount  |
 *      | `orphan_line_in_gap`                 | 1404 | tblInvoiceAmount  |
 *      | `inspection_date_unparseable`        |  716 | tblInspectionDate |
 *      | `invoice_date_missing_or_impossible` |   33 | tblInvoices       |
 *      | `orphan_line_negative_invoice_number`|    6 | tblInvoiceAmount  |
 *      | `orphan_line_header_quarantined`     |    4 | tblInvoiceAmount  |
 *      | `service_date_unparseable`           |    2 | tblCustDumpLog    |
 *      | `orphan_line_past_max`               |    1 | tblInvoiceAmount  |
 *      | `amount_paid_exceeds_total`          |    1 | tblInvoices       |
 *
 * 2. The families are not nine copies of one job, and the screen must not imply they are.
 *
 *    `orphan_line_*` — 3,124 rows, 81% of the queue — means the invoice *header* is not in
 *    the export at all. Nothing is wrong with the row you are looking at; the row it belongs
 *    to was never delivered. Recovering those means obtaining the missing headers, not
 *    editing anything.
 *
 *    `inspection_date_unparseable` is 715 rows of `<blank>` and one row of `8/1/2508`. The
 *    blanks have no value to correct — the date was never written down. The one with a value
 *    is a year typo, rejected because `pg_temp.wb_date` accepts only years 1900-2100; the
 *    same rule is what quarantined `5/18/2393` and `12/21/217`.
 *
 *    `amount_paid_exceeds_total` is a single row, and the only one here that is a live
 *    accounting discrepancy rather than a gap in the record.
 *
 *    Ranking these as one severity would be the same kind of lie the old schema told by
 *    putting everything in one `notes` column.
 *
 * 3. Resolving is a bare acknowledgement, because that is all the schema offers.
 *
 *    `resolved_at` / `resolved_by` exist; there is no `resolution_note`. The queue can
 *    record *that* a row was dealt with and *who* did it, but not *what was decided* — which
 *    for a table whose entire purpose is an audit trail is a real gap. It is not fixed here
 *    by inventing a column on an entity whose table a migration owns. The column is the fix,
 *    and DATA_MODEL §13 carries it as an open item.
 */

/** Page size, clamped. Same ceiling as the property routes. */
function paging(req: Request, max = 200): { limit: number; offset: number } {
  const raw = Number(req.query.limit);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), max) : 50;
  const page = Number(req.query.page);
  const p = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  return { limit, offset: (p - 1) * limit };
}

const INT4_MAX = 2_147_483_647;
function intParam(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= INT4_MAX ? n : null;
}

/**
 * 'open' | 'resolved' | 'all' -> a predicate, or undefined when the word is not one of those.
 *
 * Interpolated rather than bound because it is query structure, not a value. Answering
 * undefined for anything unrecognised is what keeps `?status=` from reaching the database as
 * a fragment of somebody's choosing.
 */
const STATUS_CLAUSE: Record<string, string> = {
  open: 'q.resolved_at IS NULL',
  resolved: 'q.resolved_at IS NOT NULL',
  all: 'TRUE',
};

export const quarantineController = {
  /**
   * GET /api/quarantine/families
   *
   * The nine families with their counts — the shape a filter can actually take. This is the
   * endpoint that makes the other one usable; without it the choice is between 2,944 reasons
   * and no filter at all.
   *
   * `source_files` is aggregated rather than assumed because a family that ever spanned two
   * files would otherwise be silently attributed to one.
   */
  families: async (_req: Request, res: Response) => {
    try {
      const rows = await AppDataSource.query(
        `SELECT split_part(q.reason, ':', 1)                      AS family,
                count(*)                                          AS total,
                count(*) FILTER (WHERE q.resolved_at IS NULL)     AS open,
                count(*) FILTER (WHERE q.resolved_at IS NOT NULL) AS resolved,
                array_agg(DISTINCT q.source_file)                 AS source_files
           FROM septic_app.import_quarantine q
          GROUP BY 1
          ORDER BY count(*) FILTER (WHERE q.resolved_at IS NULL) DESC, count(*) DESC`,
      );
      return res.json({ success: true, data: rows });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Quarantine families failed', error: internalError(error),
      });
    }
  },

  /**
   * GET /api/quarantine?family=&source_file=&status=&page=&limit=
   *
   * Ordered by (source_file, row_no), not by id. id is a bigserial recording the order the
   * transforms happened to run in, which means nothing to a person working the queue;
   * source_file + row_no is the file and the line number in it, so two people can be told
   * "tblInvoices line 812" and mean the same row.
   *
   * The family predicate is `split_part(...) = $n`, which cannot use idx_quarantine_open —
   * that index is a btree on (source_file, reason) and the left side here is an expression.
   * At 3,876 rows a sequential scan is the right answer and saying so is better than adding
   * an expression index for a table this size; if the queue ever reaches six figures, that
   * index is the fix and this paragraph is where to find the reason.
   */
  list: async (req: Request, res: Response) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : 'open';
      const clause = STATUS_CLAUSE[status];
      if (!clause) {
        return res.status(400).json({
          success: false, message: "status must be 'open', 'resolved' or 'all'",
        });
      }

      const family = typeof req.query.family === 'string' ? req.query.family.trim() : '';
      const sourceFile =
        typeof req.query.source_file === 'string' ? req.query.source_file.trim() : '';

      // Placeholders are numbered as the clauses are built, so a skipped filter cannot
      // leave a parameter appearing in no clause. Not a style rule: Postgres answers an
      // untyped orphan with "could not determine data type of parameter $1", which the
      // property routes learned the hard way.
      const where: string[] = [clause];
      const params: unknown[] = [];
      if (family) {
        params.push(family);
        where.push(`split_part(q.reason, ':', ${params.length}) = $${params.length}`);
      }
      if (sourceFile) {
        params.push(sourceFile);
        where.push(`q.source_file = $${params.length}`);
      }
      const whereSql = where.join(' AND ');

      const { limit, offset } = paging(req);
      params.push(limit, offset);
      const tail = params.length;

      const [rows, [counts]] = await Promise.all([
        AppDataSource.query(
          `SELECT q.id, q.source_file, q.row_no, q.reason, q.raw,
                  to_char(q.quarantined_at, 'YYYY-MM-DD') AS quarantined_at,
                  to_char(q.resolved_at, 'YYYY-MM-DD')    AS resolved_at,
                  q.resolved_by,
                  trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, ''))
                    AS resolved_by_name
             FROM septic_app.import_quarantine q
        LEFT JOIN septic_app.users u ON u.id = q.resolved_by
             WHERE ${whereSql}
             ORDER BY q.source_file, q.row_no
             LIMIT $${tail - 1} OFFSET $${tail}`,
          params,
        ),
        AppDataSource.query(
          `SELECT count(*) AS total FROM septic_app.import_quarantine q
            WHERE ${whereSql}`,
          params.slice(0, tail - 2),
        ),
      ]);

      return res.json({
        success: true,
        data: rows,
        meta: {
          total: Number(counts.total), limit, offset,
          status, family: family || null, source_file: sourceFile || null,
        },
      });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Quarantine list failed', error: internalError(error),
      });
    }
  },

  /**
   * POST /api/quarantine/:id/resolve
   *
   * The first write endpoint in the application.
   *
   * It is deliberately the smallest write possible: one timestamp and one identity on a row
   * that already exists, in a table nothing else reads. That is why the queue was chosen to
   * break the read-only streak rather than scheduling. A first write should be one where
   * being wrong costs a row of metadata, not an invoice.
   *
   * Three decisions worth keeping:
   *
   *  - `resolved_by` comes from the token, never the body. A client that could name who
   *    fixed it would produce an audit trail that anyone could write.
   *  - Resolving an already-resolved row is not an error. The UPDATE matches nothing, and
   *    reporting that as a failure would make a double-click or a network retry look like
   *    something went wrong when the thing the user wanted is already true.
   *  - A row that does not exist is a 404, told apart from the case above by asking whether
   *    the id names a row at all. Those are two different silences a person needs to hear
   *    differently: "somebody else already closed this" and "there is no such row".
   */
  resolve: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) {
        return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      }

      /**
       * One statement, and the shape of its result is the reason it is one statement.
       *
       * The obvious version — `UPDATE ... RETURNING id`, then `if (rows.length)` — is wrong
       * here, and wrong in the way that survives review. TypeORM's `query()` returns a tuple
       * `[rows, rowCount]` for a data-modifying statement, not the row array it returns for a
       * SELECT. So `.length` is 2 whether the UPDATE matched a row or nothing at all: the
       * write happens, every response says success, and "already resolved" and "no such row"
       * both silently report a fresh success. Measured:
       *
       *   matched      -> [[{"id":"23274"}], 1]   .length === 2
       *   matched none -> [[], 0]                 .length === 2
       *
       * Wrapping the write in a CTE and selecting from it sidesteps the whole question: the
       * statement's result is a SELECT, so `query()` gives back ordinary rows, and the two
       * kinds of "nothing happened" arrive as data rather than as an inference.
       *
       * It is also atomic. The UPDATE-then-check version has a window in which a second
       * request can resolve the row between the two statements, and the first caller would
       * then report "no such row" for a row that exists and is now somebody else's.
       *
       * Postgres runs the CTE against one snapshot, so `q` below is the row as it was *before*
       * the update — which is the thing worth reporting when the row was already closed.
       *
       * Zero rows back means the id names nothing; that is the 404.
       */
      const [row] = await AppDataSource.query(
        `WITH u AS (
             UPDATE septic_app.import_quarantine
                SET resolved_at = now(), resolved_by = $2
              WHERE id = $1 AND resolved_at IS NULL
             RETURNING id
         )
         SELECT (SELECT count(*) FROM u)::int        AS updated,
                to_char(q.resolved_at, 'YYYY-MM-DD') AS resolved_at,
                q.resolved_by
           FROM (SELECT id, resolved_at, resolved_by
                   FROM septic_app.import_quarantine WHERE id = $1) q`,
        [id, req.user!.userId],
      );

      if (!row) {
        return res.status(404).json({ success: false, message: 'Quarantine row not found' });
      }

      if (Number(row.updated) === 1) {
        return res.json({ success: true, data: { id, resolved: true, already_resolved: false } });
      }

      return res.json({
        success: true,
        data: {
          id, resolved: true, already_resolved: true,
          resolved_at: row.resolved_at, resolved_by: row.resolved_by,
        },
      });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Quarantine resolve failed', error: internalError(error),
      });
    }
  },

  /**
   * POST /api/quarantine/:id/unresolve
   *
   * The undo exists because the mistake it prevents is the common one: one wrong click two
   * screens deep, and the queue has quietly lost a row that still needs work. With no
   * resolution note and no history, an accidental resolve is otherwise indistinguishable
   * from a real one, and 3,876 rows is not a number anyone will notice drifting.
   */
  unresolve: async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) {
        return res.status(400).json({ success: false, message: 'id must be a positive integer' });
      }

      /** Same shape as `resolve`, for the same reason: see the note there. */
      const [row] = await AppDataSource.query(
        `WITH u AS (
             UPDATE septic_app.import_quarantine
                SET resolved_at = NULL, resolved_by = NULL
              WHERE id = $1 AND resolved_at IS NOT NULL
             RETURNING id
         )
         SELECT (SELECT count(*) FROM u)::int AS updated
           FROM (SELECT id FROM septic_app.import_quarantine WHERE id = $1) q`,
        [id],
      );

      if (!row) {
        return res.status(404).json({ success: false, message: 'Quarantine row not found' });
      }

      return res.json({
        success: true,
        data: { id, resolved: false, already_open: Number(row.updated) === 0 },
      });
    } catch (error) {
      return res.status(500).json({
        success: false, message: 'Quarantine unresolve failed', error: internalError(error),
      });
    }
  },
};

