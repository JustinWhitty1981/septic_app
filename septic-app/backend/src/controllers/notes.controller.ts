import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';

function intParam(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

/**
 * Field notes (DRV-14, the append half).
 *
 * DRV-14 is the requirement that decides who wins when the office and the
 * tablet disagree, and its answer is: nobody merges, because nobody should
 * have to. The server owns the schedule and the status; the device owns what
 * it saw — notes and photos — and what a device says is *appended*, never
 * reconciled. Two tablets that both wrote "lid was cracked" produce two notes
 * saying it, and that is correct: two observations happened, and the second
 * one overwriting the first would delete the fact that the first driver was
 * there and saw it. `job_notes` is append-only for exactly this reason, and
 * this endpoint has no UPDATE, no upsert, and no field-level COALESCE — the
 * merge logic the requirement says must not exist stays not existing.
 *
 * `client_uuid` makes the flaky-signal retry idempotent (same replay semantics
 * as the dispatch endpoint): the retry of one note is one row, because the
 * event "driver typed this" happened once.
 */
export const createNote = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const body = req.body?.body;
    if (typeof body !== 'string' || body.trim().length === 0) {
      return res.status(400).json({ error: 'body is required' });
    }
    if (body.length > 10_000) {
      return res.status(400).json({ error: 'body is too long (10,000 characters)' });
    }
    const clientUuid = req.body?.client_uuid;
    if (clientUuid !== undefined
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(clientUuid))) {
      return res.status(400).json({ error: 'client_uuid must be a UUID' });
    }
    const refs: Array<[string, string]> = [
      ['service_event_id', 'service_events'],
      ['route_stop_id', 'route_stops'],
      ['property_id', 'properties'],
    ];
    const ids: Record<string, number | null> = {};
    for (const [field, table] of refs) {
      if (req.body?.[field] == null) { ids[field] = null; continue; }
      const n = intParam(req.body[field]);
      if (n === null) return res.status(400).json({ error: `${field} must be a positive integer` });
      const [exists] = await AppDataSource.query(
        `SELECT 1 FROM septic_app.${table} WHERE id = $1`, [n],
      );
      if (!exists) return res.status(404).json({ error: `${field} ${n} does not exist` });
      ids[field] = n;
    }

    const note = await AppDataSource.transaction(async (em) => {
      if (clientUuid) {
        const [prior] = await em.query(
          `SELECT id, body, author_id, client_created_at, created_at
             FROM septic_app.job_notes WHERE client_uuid = $1`,
          [clientUuid],
        );
        if (prior) return { kind: 'replay', note: prior } as const;
      }
      // The device's clock is the ordering key for a timeline (idx_notes_property
      // sorts by it); the server's clock is the audit of when we heard about it.
      // Both are kept because they answer different questions and neither is a
      // substitute for the other.
      const clientAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(req.body?.client_created_at))
        ? new Date(req.body.client_created_at) : new Date();
      const [row] = await em.query(
        `INSERT INTO septic_app.job_notes
           (client_uuid, service_event_id, property_id, route_stop_id, author_id, body, client_created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (client_uuid) DO NOTHING
         RETURNING id, body, author_id, client_created_at, created_at`,
        [
          clientUuid ?? null, ids.service_event_id, ids.property_id, ids.route_stop_id,
          (req.user as { userId: number }).userId, body, clientAt,
        ],
      );
      if (!row) {
        const [winner] = await em.query(
          `SELECT id, body, author_id, client_created_at, created_at
             FROM septic_app.job_notes WHERE client_uuid = $1`, [clientUuid],
        );
        return { kind: 'replay', note: winner } as const;
      }
      return { kind: 'written', note: row } as const;
    });
    if (note.kind === 'replay') return res.status(200).json({ ...note.note, replay: true });
    return res.status(201).json(note.note);
  } catch (e) {
    return res.status(500).json({ error: internalError(e) });
  }
};

/** The notes on one thing, newest first. Read-only: there is nothing to edit. */
export const listNotes = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const [field, table]: [string, string] =
      req.query.service_event_id !== undefined ? ['service_event_id', 'service_events']
      : req.query.route_stop_id !== undefined ? ['route_stop_id', 'route_stops']
      : req.query.property_id !== undefined ? ['property_id', 'properties']
      : ['', ''];
    if (!field) return res.status(400).json({ error: 'one of service_event_id, route_stop_id, property_id is required' });
    const id = intParam(req.query[field]);
    if (id === null) return res.status(400).json({ error: `${field} must be a positive integer` });
    const [exists] = await AppDataSource.query(
      `SELECT 1 FROM septic_app.${table} WHERE id = $1`, [id],
    );
    if (!exists) return res.status(404).json({ error: `${field} ${id} does not exist` });
    const rows = await AppDataSource.query(
      `SELECT id, client_uuid, author_id, body, client_created_at, created_at
         FROM septic_app.job_notes WHERE ${field} = $1
        ORDER BY client_created_at DESC, id DESC LIMIT 200`,
      [id],
    );
    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ error: internalError(e) });
  }
};
