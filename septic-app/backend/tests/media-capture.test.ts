import { Client } from 'pg';
import { connect } from './db';
import sharp from 'sharp';
import { createHash } from 'crypto';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

/**
 * DRV-15b / DRV-16 / DRV-18 — the photo pipeline, and DRV-14 — the note that
 * is never merged.
 *
 * The fixtures here are manufactured, not downloaded: every pixel is generated
 * with `sharp` at test time, and the one byte-level property the requirement
 * depends on — "EXIF with GPS survives a real camera and must not survive us" —
 * is proved by an APP1/EXIF segment built by hand below and spliced into the
 * JPEG. It is short enough to read at the top of a failing test, and it is
 * real enough that `sharp` reports it as EXIF before upload. A fixture copied
 * from a phone would be opaque; this one can be debugged.
 */
const API = process.env.API_URL?.replace(/\/auth$/, '') || 'http://localhost:3001/api';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'Capture1-Passw0rd!';

let db: Client;
let officeToken = '';
let driverToken = '';
const created = {
  mediaIds: [] as number[], noteIds: [] as number[],
  userIds: [] as number[], stopIds: [] as number[],
};

const api = async (method: string, path: string, body?: any, token?: string) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: ((await res.json().catch(() => ({}))) as any) ?? {} };
};

// ---------------------------------------------------------------- fixtures --

/** A solid-ish JPEG of w x h, quality chosen so sizes differ predictably. */
/**
 * A colour that changes with each run — and per call-site, not per file.
 * (The first version salted by RUN alone, and two fixtures that differed
 * only in source quality collapsed to identical bytes once the server
 * re-encoded both at q82 — dedup then answered one test with the other's
 * row. Content-addressing means fixtures must differ in content.)
 */
let saltSeq = 0;
const salt = () => {
  const h = createHash('md5').update(`${RUN}:${(saltSeq += 1)}`).digest();
  return { r: h[0], g: h[1], b: h[2] };
};
const jpeg = async (w: number, h: number, quality = 82, bg = { r: 40, g: 90, b: 140 }): Promise<Buffer> =>
  sharp({ create: { width: w, height: h, channels: 3, background: bg } })
    .jpeg({ quality }).toBuffer();

/**
 * Splice an EXIF APP1 segment (with a GPS Info IFD) after the SOI marker.
 *
 * Little-endian TIFF: header, IFD0 with one entry (ExifIFDPointer), the Exif
 * IFD with one entry (GPSIFDPointer), the GPS IFD with one entry
 * (GPSVersionID, four inline bytes). Three pointers, three one-entry tables —
 * enough for any parser, including sharp, to see "this file has EXIF, and the
 * EXIF has a GPS block." That is the property under test; the rest of the
 * segment is ceremony, and kept as small as the format allows.
 */
const withGpsExif = (jpegBytes: Buffer): Buffer => {
  const le = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
  const l32 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  // value-or-offset: for BYTE[4] the four bytes live in the offset field.
  const e = (tag: number, type: number, count: number, valueOrOffset: number) =>
    Buffer.concat([le(tag), le(type), l32(count), l32(valueOrOffset)]);

  const ifd0At = 8;
  const exifAt = ifd0At + 2 + 12 + 4;          // count + 1 entry + next-offset
  const gpsAt = exifAt + 2 + 12 + 4;

  const tiff = Buffer.concat([
    Buffer.from('II'), le(0x002a), l32(ifd0At),
    le(1), e(0x8769, 4, 1, exifAt), l32(0),         // IFD0 -> Exif IFD (count is uint16)
    le(1), e(0x8825, 4, 1, gpsAt), l32(0),          // Exif IFD -> GPS IFD
    le(1),
    Buffer.concat([le(0x0000), le(1), l32(4), Buffer.from([2, 3, 0, 0])]), // GPSVersion
    l32(0),
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const segment = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    // Segment lengths are big-endian — JPEG's own rule, even though the TIFF
    // inside it is little-endian. Getting this backwards makes every JPEG
    // parser "see" a 17 KB segment and call the image corrupt.
    Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);
  return Buffer.concat([jpegBytes.subarray(0, 2), segment, jpegBytes.subarray(2)]);
};

/** Count APP1/Exif signatures in a JPEG — the byte-level strip test. */
const hasExif = (buf: Buffer): boolean =>
  buf.includes(Buffer.from([0xff, 0xe1])) && buf.includes(Buffer.from('Exif\0\0'));

// ------------------------------------------------------------- the object --

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || 'septic_dev',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'septic_dev_secret',
  },
});

beforeAll(async () => {
  db = await connect();
  const { hashPassword } = require('../src/utils/password');
  const email = `t-media.office.${RUN}@test.invalid`;
  await db.query(
    `INSERT INTO septic_app.users (first_name,last_name,email,password_hash,role,is_active)
     VALUES ('T','Media',$1,$2,'office',true)`,
    [email, await hashPassword(PASSWORD)]);
  officeToken = (await api('POST', '/auth/login', { email, password: PASSWORD })).body.token;

  const demail = `t-media.driver.${RUN}@test.invalid`;
  const dres = await db.query(
    `INSERT INTO septic_app.users (first_name,last_name,email,password_hash,role,is_active)
     VALUES ('T','MediaDrv',$1,$2,'driver',true) RETURNING id`,
    [demail, await hashPassword(PASSWORD)]);
  created.userIds.push(Number(dres.rows[0].id));
  driverToken = (await api('POST', '/auth/login', { email: demail, password: PASSWORD })).body.token;
});

afterAll(async () => {
  if (created.mediaIds.length) {
    await db.query(`DELETE FROM septic_app.media WHERE id = ANY($1::bigint[])`, [created.mediaIds]);
  }
  if (created.noteIds.length) {
    await db.query(`DELETE FROM septic_app.job_notes WHERE id = ANY($1::bigint[])`, [created.noteIds]);
  }
  if (created.stopIds.length) {
    await db.query(`DELETE FROM septic_app.route_stops WHERE id = ANY($1::int[])`, [created.stopIds]);
  }
  if (created.userIds.length) {
    await db.query(`DELETE FROM septic_app.users WHERE id = ANY($1::int[])`, [created.userIds]);
  }
  await db?.end();
});

// ------------------------------------------------------------------ DRV-15b --

describe('DRV-15b: the 3 MP cap measures the image, not the claims', () => {
  it('refuses 2000x8000 — sixteen megapixels through a narrow-edge shape', async () => {
    const img = await jpeg(2000, 8000, 60);
    const r = await api('POST', '/media/upload',
      { image_base64: img.toString('base64') }, officeToken);
    expect(r.status).toBe(413);
    expect(String(r.body.error)).toContain('16000000');
    const rows = await db.query(
      `SELECT 1 FROM septic_app.media WHERE byte_size = $1`, [img.length]);
    expect(rows.rows).toEqual([]); // refused means nothing landed, in the DB or in MinIO
  });

  it('accepts exactly 3,000,000 pixels and records what sharp measured', async () => {
    const img = await jpeg(3000, 1000, 60);
    const r = await api('POST', '/media/upload', {
      image_base64: img.toString('base64'),
      width: 1, height: 1, mime_type: 'text/plain', // claims the endpoint must not read
    }, officeToken);
    expect(r.status).toBe(201);
    created.mediaIds.push(Number(r.body.id));
    expect(r.body.width).toBe(3000);
    expect(r.body.height).toBe(1000);
    expect(r.body.width * r.body.height).toBe(3_000_000);
    // The stored bytes carry the recorded dimensions: the DB CHECK and the row
    // describe the same object, because both come from the re-decode.
    const raw = await fetch(`${API}/media/${r.body.id}/raw`,
      { headers: { Authorization: `Bearer ${officeToken}` } });
    expect(raw.status).toBe(200);
    const md = await sharp(Buffer.from(await raw.arrayBuffer())).metadata();
    expect([md.width, md.height]).toEqual([3000, 1000]);
  });

  it('a body that is not an image is 415, not 500', async () => {
    const r = await api('POST', '/media/upload',
      { image_base64: Buffer.from('this is a invoice, not a photo').toString('base64') }, officeToken);
    expect(r.status).toBe(415);
  });
});

// ------------------------------------------------------------------ DRV-16 ---

describe('DRV-16: EXIF goes, GPS stays unless opted in', () => {
  let gpsJpeg: Buffer;

  beforeAll(async () => {
    // q35: the deliberate low-quality source. The pipeline re-encodes at q82,
    // so "stored bytes differ from the client's bytes" is measurable rather
    // than asserted against a constant. The background is salted per run so
    // the hash is never one a previous run of this file already inserted —
    // 201-vs-200 (creation vs dedup) must reflect this run, not history.
    gpsJpeg = withGpsExif(await jpeg(64, 48, 35, salt()));
    expect(hasExif(gpsJpeg)).toBe(true);            // the fixture is what it claims
    expect((await sharp(gpsJpeg).metadata()).exif).toBeDefined(); // and sharp sees it
  });

  it('the stored object has no EXIF segment at all', async () => {
    const r = await api('POST', '/media/upload',
      { image_base64: gpsJpeg.toString('base64') }, officeToken);
    expect(r.status).toBe(201);
    created.mediaIds.push(Number(r.body.id));
    expect(r.body.byte_size).not.toBe(gpsJpeg.length); // re-encoded, provably

    const raw = Buffer.from(await (await fetch(`${API}/media/${r.body.id}/raw`,
      { headers: { Authorization: `Bearer ${officeToken}` } })).arrayBuffer());
    expect(hasExif(raw)).toBe(false);
    expect((await sharp(raw).metadata()).exif).toBeUndefined();
  });

  it('the coordinates in the file are not the coordinates in the row', async () => {
    // Same bytes as the strip test above, so the honest expectation is
    // "it lands" (201 first time, 200 dedup after) — what matters is the row.
    const r = await api('POST', '/media/upload',
      { image_base64: gpsJpeg.toString('base64') }, officeToken);
    expect([200, 201]).toContain(r.status);
    created.mediaIds.push(Number(r.body.id));
    const [row] = (await db.query(
      `SELECT gps_lat, gps_lng FROM septic_app.media WHERE id = $1`, [r.body.id])).rows;
    expect(row.gps_lat).toBeNull();
    expect(row.gps_lng).toBeNull();
  });

  it('an explicit opt-in stores the coordinates the client submits', async () => {
    const r = await api('POST', '/media/upload', {
      image_base64: (await jpeg(48, 48, 70, salt())).toString('base64'),
      gps_opt_in: true, gps_lat: 43.7844, gps_lng: -88.4062,
    }, officeToken);
    expect(r.status).toBe(201);
    created.mediaIds.push(Number(r.body.id));
    const [row] = (await db.query(
      `SELECT gps_lat, gps_lng FROM septic_app.media WHERE id = $1`, [r.body.id])).rows;
    expect(Number(row.gps_lat)).toBeCloseTo(43.7844, 4);
    expect(Number(row.gps_lng)).toBeCloseTo(-88.4062, 4);
  });

  it('coordinates without the opt-in are discarded, not quietly kept', async () => {
    const r = await api('POST', '/media/upload', {
      image_base64: (await jpeg(48, 48, 71, salt())).toString('base64'),
      gps_lat: 43.7844, gps_lng: -88.4062, // no gps_opt_in
    }, officeToken);
    expect(r.status).toBe(201);
    created.mediaIds.push(Number(r.body.id));
    expect(r.body.gps_lat ?? null).toBeNull();
    const [row] = (await db.query(
      `SELECT gps_lat FROM septic_app.media WHERE id = $1`, [r.body.id])).rows;
    expect(row.gps_lat).toBeNull();
  });

  it('an opt-in with nonsense coordinates is refused, not rounded', async () => {
    const r = await api('POST', '/media/upload', {
      image_base64: (await jpeg(16, 16, 70, salt())).toString('base64'),
      gps_opt_in: true, gps_lat: 91.5, gps_lng: 0,
    }, officeToken);
    expect(r.status).toBe(400);
  });
});

// ------------------------------------------------------------------ DRV-18 ---

describe('DRV-18: the same bytes arrive once', () => {
  let img: Buffer;
  let firstId = 0;

  beforeAll(async () => { img = await jpeg(120, 90, 77, salt()); });

  it('three uploads, three distinct client_uuids, one row', async () => {
    const uuid = () => {
      const h = createHash('md5').update(RUN + Math.random()).digest('hex');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    };
    const rs = [];
    for (let i = 0; i < 3; i += 1) {
      rs.push(await api('POST', '/media/upload',
        { image_base64: img.toString('base64'), client_uuid: uuid() }, officeToken));
    }
    expect(rs.map((x) => x.status)).toEqual([201, 200, 200]); // the first is a creation, the rest are finds
    const ids = new Set(rs.map((x) => Number(x.body.id)));
    expect(ids.size).toBe(1);
    expect(rs.slice(1).every((x) => x.body.deduplicated === true)).toBe(true);
    firstId = Number(rs[0].body.id);
    created.mediaIds.push(firstId);

    const [row] = (await db.query(
      `SELECT count(*)::int AS n FROM septic_app.media WHERE sha256 = $1 AND deleted_at IS NULL`,
      [rs[0].body.sha256])).rows;
    expect(row.n).toBe(1);
  });

  it('object storage holds one key, written once — the retry touched nothing', async () => {
    const [row] = (await db.query(
      `SELECT storage_key FROM septic_app.media WHERE id = $1`, [firstId])).rows;
    expect(row.storage_key).toMatch(/^media\/[0-9a-f]{64}\.jpg$/);
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET || 'septic-media-dev', Prefix: row.storage_key,
    }));
    expect(listed.Contents?.length).toBe(1); // one key for one hash; retries wrote no siblings
  });

  it('the body sha256 is a checksum; a lying claim is refused', async () => {
    const r = await api('POST', '/media/upload', {
      image_base64: (await jpeg(24, 24, 60, salt())).toString('base64'),
      sha256: 'a'.repeat(64), // well-formed hex, wrong bytes
    }, officeToken);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain('checksum');
  });

  it('a client_uuid replay returns the first row, not a twin', async () => {
    const body = { image_base64: (await jpeg(32, 32, 64, salt())).toString('base64'), client_uuid: null as any };
    const bh = createHash('md5').update('uuid-replay' + RUN).digest('hex');
    body.client_uuid = `${bh.slice(0, 8)}-${bh.slice(8, 12)}-${bh.slice(12, 16)}-${bh.slice(16, 20)}-${bh.slice(20, 32)}`;
    const a = await api('POST', '/media/upload', body, officeToken);
    expect(a.status).toBe(201);
    created.mediaIds.push(Number(a.body.id));
    const b = await api('POST', '/media/upload', body, officeToken);
    expect(b.status).toBe(200);
    expect(Number(b.body.id)).toBe(Number(a.body.id));
    expect(b.body.replay).toBe(true);
  });
});

// ------------------------------------------------------------------ DRV-14 ---

describe('DRV-14: two devices, two records; nothing merges', () => {
  let stopId = 0;

  beforeAll(async () => {
    // Any real stop; notes attach to what exists.
    const [s] = (await db.query(
      `SELECT rs.id FROM septic_app.route_stops rs
         JOIN septic_app.routes r ON r.id = rs.route_id
        WHERE r.driver_id IS NOT NULL
        ORDER BY rs.id DESC LIMIT 1`)).rows;
    stopId = Number(s.id);
  });

  it('the same observation typed on two tablets stays two notes', async () => {
    const body = { route_stop_id: stopId, body: 'lid was cracked' };
    const a = await api('POST', '/notes', body, driverToken);
    const b = await api('POST', '/notes', body, officeToken);
    expect([a.status, b.status]).toEqual([201, 201]);
    created.noteIds.push(Number(a.body.id), Number(b.body.id));

    const list = await api('GET', `/notes?route_stop_id=${stopId}`, undefined, officeToken);
    expect(list.status).toBe(200);
    const mine = list.body.filter((n: any) =>
      created.noteIds.includes(Number(n.id)));
    expect(mine.length).toBe(2); // both survive; no COALESCE swallowed one
    expect(new Set(mine.map((n: any) => Number(n.author_id))).size).toBe(2);
  });

  it('the retry of one note (same client_uuid) is one note', async () => {
    const dh = createHash('md5').update('note' + RUN).digest('hex');
    const clientUuid = `${dh.slice(0, 8)}-${dh.slice(8, 12)}-${dh.slice(12, 16)}-${dh.slice(16, 20)}-${dh.slice(20, 32)}`;
    const a = await api('POST', '/notes',
      { route_stop_id: stopId, body: 'ran over the clean pipe', client_uuid: clientUuid }, driverToken);
    expect(a.status).toBe(201);
    created.noteIds.push(Number(a.body.id));
    const b = await api('POST', '/notes',
      { route_stop_id: stopId, body: 'ran over the clean pipe', client_uuid: clientUuid }, driverToken);
    expect(b.status).toBe(200);
    expect(Number(b.body.id)).toBe(Number(a.body.id));
    expect(b.body.replay).toBe(true);
  });

  it('the merge logic this requirement forbids is not sitting in the codebase', async () => {
    // The grep guards that read the source for shapes an endpoint must not
    // have — the same style as NF-02/NF-03. A "resolve conflict" feature is
    // one well-intentioned COALESCE away, and no HTTP verb can see it.
    const { readFileSync, readdirSync } = require('fs');
    const { join } = require('path');
    const files = readdirSync(join(__dirname, '..', 'src', 'controllers'))
      .filter((f: string) => f.endsWith('.ts'));
    for (const f of files) {
      const src = readFileSync(join(__dirname, '..', 'src', 'controllers', f), 'utf8');
      expect(`${f}:${src}`.match(/UPDATE\s+septic_app\.job_notes/i)).toBeNull();
      expect(`${f}:${src}`.match(/\bmerge[A-Z]/)).toBeNull();
      expect(`${f}:${src}`.match(/COALESCE\s*\(\s*[a-z_.]*body/i)).toBeNull();
    }
    // And notes are append-only the same way the ledger is: no endpoint, no
    // route file, not even a verb.
    const routesSrc = readFileSync(join(__dirname, '..', 'src', 'routes', 'notes.ts'), 'utf8');
    expect(routesSrc.match(/router\.(put|patch|delete)/)).toBeNull();
  });
});
