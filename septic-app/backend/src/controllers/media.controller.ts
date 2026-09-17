import { Request, Response } from 'express';
import { createHash } from 'crypto';
import sharp, { Metadata as SharpMetadata } from 'sharp';
import { AppDataSource } from '../config/database';
import { internalError } from '../utils/errors';
import { bucket, putObject, getObject } from '../services/storage';

const MAX_PIXELS = 3_000_000;

function intParam(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

function coord(value: unknown, lo: number, hi: number): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

/**
 * Photo upload (DRV-15b / DRV-16 / DRV-18).
 *
 * Three requirements share one endpoint because they share one fact: after a
 * photo passes through here, what is stored is the server's re-encoding, not
 * the client's file. Every other rule falls out of that.
 *
 * DRV-15b (the 3 MP cap measures the image, not the claims): the cap is
 * computed from `sharp` metadata — the header the encoder wrote — never from
 * body fields, and never from a decoded-edge check. `metadata` parses the
 * header without decoding pixels, so a 16 MP claim is refused before the
 * server spends memory proving it. The width/height stored are the ones the
 * *stored bytes* carry, so the DB CHECK (`width*height <= 3000000`) and the
 * stored numbers cannot drift from each other, and a body that claims `width`
 * has no way to be believed: this endpoint does not look at it.
 *
 * DRV-16 (EXIF is stripped unconditionally; GPS is stored only on opt-in):
 * `sharp().rotate()` reads the orientation tag, applies the rotation, and then
 * no metadata is written back — re-encoding is the stripper, not a scrubber,
 * so there is no "did we remember to scrub" failure mode. Coordinates are the
 * one field with an explicit opt-in, and the value is taken from the body, not
 * from EXIF. That is a deliberate limit on the opt-in's meaning: the flag
 * stores what the driver's phone *said at capture time*, because scraping the
 * file behind the flag would mean "GPS is only stored on opt-in" depends on
 * remembering to also gate the scraper — and scrapers get forgotten.
 *
 * DRV-18 (a retried upload does not duplicate, keyed on sha256): identity is
 * the hash of the stored bytes. Note the subtlety: a retried upload sends the
 * same original file, and re-encoding is deterministic for a given sharp
 * version, so the retried upload arrives at the same hash and finds the row
 * already there. The `sha256` field in the body, if present, is checked
 * against the *decoded input* and is never an identity — it is a checksum
 * against a corrupt transfer, and a mismatched claim is refused, because a
 * field that is trusted is a field someone will eventually forge.
 */
export const uploadMedia = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const b64 = req.body?.image_base64;
    const claimedUuid = req.body?.client_uuid;
    if (typeof b64 !== 'string' || b64.length === 0) {
      return res.status(400).json({ error: 'image_base64 is required' });
    }
    if (claimedUuid !== undefined
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(claimedUuid))) {
      return res.status(400).json({ error: 'client_uuid must be a UUID' });
    }
    // A replay can be answered before anything is decoded: the answer to a
    // duplicate is the first row, and reading it is cheaper than hashing.
    if (claimedUuid) {
      const [prior] = await AppDataSource.query(
        `SELECT id, sha256, byte_size, width, height, mime_type
           FROM septic_app.media WHERE client_uuid = $1 AND deleted_at IS NULL`,
        [claimedUuid],
      );
      if (prior) return res.status(200).json({ ...prior, deduplicated: true, replay: true });
    }

    const input = Buffer.from(b64, 'base64');
    // Buffer.from(base64) accepts garbage rather than failing, so the real
    // validation is whether an image is in there at all.
    let meta: SharpMetadata;
    try {
      meta = await sharp(input, { failOn: 'error' }).metadata();
    } catch {
      return res.status(415).json({ error: 'body did not decode as an image' });
    }
    if (!meta.width || !meta.height || !['jpeg', 'png', 'webp'].includes(meta.format ?? '')) {
      return res.status(415).json({ error: 'only jpeg, png and webp photos are accepted' });
    }
    if (meta.width * meta.height > MAX_PIXELS) {
      return res.status(413).json({
        error: `image is ${meta.width}x${meta.height} (${meta.width * meta.height} px), `
             + `limit is ${MAX_PIXELS} total pixels`,
      });
    }
    if (typeof req.body?.sha256 === 'string') {
      const actual = createHash('sha256').update(input).digest('hex');
      if (actual !== req.body.sha256.toLowerCase()) {
        return res.status(400).json({
          error: 'sha256 in the body does not match the bytes uploaded — it is a checksum, not an identity',
        });
      }
    }

    // The strip: re-encode, orientation applied, no metadata carried over.
    const stored = await sharp(input).rotate().jpeg({ quality: 82 }).toBuffer();
    const storedMeta = await sharp(stored).metadata();
    const sha256 = createHash('sha256').update(stored).digest('hex');
    const key = `media/${sha256}.jpg`;

    const gpsOptIn = req.body?.gps_opt_in === true;
    const gpsLat = gpsOptIn ? coord(req.body?.gps_lat, -90, 90) : null;
    const gpsLng = gpsOptIn ? coord(req.body?.gps_lng, -180, 180) : null;
    if (gpsLat === null || gpsLng === null) {
      if (gpsOptIn && (req.body?.gps_lat !== undefined || req.body?.gps_lng !== undefined)) {
        return res.status(400).json({ error: 'gps_lat/gps_lng must be real coordinates' });
      }
    }

    const eventId = req.body?.service_event_id == null ? null : intParam(req.body.service_event_id);
    const stopId = req.body?.route_stop_id == null ? null : intParam(req.body.route_stop_id);
    const propId = req.body?.property_id == null ? null : intParam(req.body.property_id);
    if (req.body?.service_event_id != null && eventId === null) {
      return res.status(400).json({ error: 'service_event_id must be a positive integer' });
    }
    if (req.body?.route_stop_id != null && stopId === null) {
      return res.status(400).json({ error: 'route_stop_id must be a positive integer' });
    }
    if (req.body?.property_id != null && propId === null) {
      return res.status(400).json({ error: 'property_id must be a positive integer' });
    }

    const outcome = await AppDataSource.transaction(async (em) => {
      if (eventId !== null) {
        const [ev] = await em.query(`SELECT 1 FROM septic_app.service_events WHERE id = $1`, [eventId]);
        if (!ev) return { kind: 'no-event' } as const;
      }
      if (stopId !== null) {
        const [st] = await em.query(`SELECT 1 FROM septic_app.route_stops WHERE id = $1`, [stopId]);
        if (!st) return { kind: 'no-stop' } as const;
      }
      if (propId !== null) {
        const [p] = await em.query(`SELECT 1 FROM septic_app.properties WHERE id = $1`, [propId]);
        if (!p) return { kind: 'no-property' } as const;
      }

      // The hash is checked against the database, not against memory: two
      // phones uploading the same photo race, and the advisory lock plus the
      // partial unique index (0024) is what makes "one row per sha256" true
      // when the race actually happens (SCH-05's lesson, re-earned).
      await em.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`media:${sha256}`]);
      const [existing] = await em.query(
        `SELECT id, sha256, byte_size, width, height, mime_type
           FROM septic_app.media WHERE sha256 = $1 AND deleted_at IS NULL`,
        [sha256],
      );
      if (existing) return { kind: 'deduped', media: existing } as const;

      await putObject(key, stored, 'image/jpeg');
      const [row] = await em.query(
        `INSERT INTO septic_app.media
           (client_uuid, service_event_id, property_id, route_stop_id, uploaded_by,
            storage_bucket, storage_key, sha256, mime_type, byte_size, width, height,
            kind, caption, gps_lat, gps_lng, upload_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'image/jpeg',$9,$10,$11,'full',$12,$13,$14,'ready')
         ON CONFLICT (sha256) WHERE deleted_at IS NULL DO NOTHING
         RETURNING id, sha256, byte_size, width, height, mime_type`,
        [
          claimedUuid ?? null, eventId, propId, stopId, (req.user as { userId: number }).userId,
          bucket(), key, sha256, stored.length,
          storedMeta.width, storedMeta.height,
          typeof req.body?.caption === 'string' ? req.body.caption.slice(0, 500) : null,
          gpsLat, gpsLng,
        ],
      );
      if (!row) {
        const [winner] = await em.query(
          `SELECT id, sha256, byte_size, width, height, mime_type
             FROM septic_app.media WHERE sha256 = $1 AND deleted_at IS NULL`, [sha256],
        );
        return { kind: 'deduped', media: winner } as const;
      }
      return { kind: 'written', media: row } as const;
    });

    if (outcome.kind === 'no-event') return res.status(404).json({ error: 'Service event not found' });
    if (outcome.kind === 'no-stop') return res.status(404).json({ error: 'Route stop not found' });
    if (outcome.kind === 'no-property') return res.status(404).json({ error: 'Property not found' });
    const deduped = outcome.kind === 'deduped';
    return res.status(deduped ? 200 : 201).json({
      ...outcome.media,
      deduplicated: deduped,
      url: `/api/media/${outcome.media.id}/raw`,
    });
  } catch (e) {
    return res.status(500).json({ error: internalError(e) });
  }
};

/** Metadata of one stored photo, and (via /raw) its bytes. */
export const getMedia = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const id = intParam(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Media id must be a positive integer' });
    const [row] = await AppDataSource.query(
      `SELECT id, service_event_id, property_id, route_stop_id, uploaded_by,
              sha256, mime_type, byte_size, width, height, kind, caption,
              gps_lat, gps_lng, upload_status, created_at, storage_key
         FROM septic_app.media WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!row) return res.status(404).json({ error: 'Media not found' });
    return res.json(row);
  } catch (e) {
    return res.status(500).json({ error: internalError(e) });
  }
};

/**
 * The stored bytes. Served through the API rather than by handing out presigned
 * URLs because the bucket is private by policy (the compose MinIO and any
 * real-S3 bucket behind a VPC endpoint both expect this), and the caller's
 * identity has already been checked by `authenticate` — presigning would just
 * move the authorization question to a URL that outlives the answer.
 */
export const getMediaRaw = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const id = intParam(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Media id must be a positive integer' });
    const [row] = await AppDataSource.query(
      `SELECT storage_key, mime_type FROM septic_app.media WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!row) return res.status(404).json({ error: 'Media not found' });
    const bytes = await getObject(row.storage_key);
    res.setHeader('content-type', row.mime_type);
    res.setHeader('cache-control', 'private, max-age=300');
    res.setHeader('etag', `"${String(id)}"`);
    return res.status(200).send(bytes);
  } catch (e) {
    return res.status(500).json({ error: internalError(e) });
  }
};
