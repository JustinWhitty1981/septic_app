import { Client } from 'pg';
import { connect } from './db';

/**
 * DRV-15 — the media size cap is on *total pixels*, not on any single edge.
 *
 * Two directions matter and both are asserted here, because the obvious
 * implementation (cap the width) gets one of them wrong:
 *   - 2000x8000 is 16 MP but only 2000 wide, so a width check lets it through.
 *   - 10000x300 is exactly 3 MP, and a width check wrongly rejects a panorama.
 *
 * Everything runs inside one transaction that is rolled back, so the suite leaves
 * no rows behind even though the tables are otherwise empty.
 */
let db: Client;
let author: number;

beforeAll(async () => {
  db = await connect();
  const rows = (await db.query('SELECT id FROM septic_app.users ORDER BY id LIMIT 1')).rows;
  expect(rows.length).toBe(1); // created by `npm run seed:user`
  author = rows[0].id;
  await db.query('BEGIN');
});

afterAll(async () => {
  await db?.query('ROLLBACK');
  await db?.end();
});

let attemptNo = 0;

const attempt = async (width: number | null, height: number | null) => {
  await db.query('SAVEPOINT cap');
  // storage_key is unique, so each attempt needs its own or the insert fails on
  // the key rather than on the pixel check being tested.
  const key = `cap-${++attemptNo}`;
  try {
    await db.query(
      `INSERT INTO septic_app.media
         (storage_bucket, storage_key, sha256, byte_size, kind, mime_type,
          width, height, uploaded_by)
       VALUES ('b',$1,$2,1000,'full','image/jpeg',$3,$4,$5)`,
      [key, `${key}-${width}x${height}`, width, height, author],
    );
    return { ok: true as const };
  } catch (e: any) {
    await db.query('ROLLBACK TO SAVEPOINT cap');
    return { ok: false as const, message: String(e.message) };
  }
};

describe('DRV-15: the cap counts pixels, not edges', () => {
  it('rejects 2000x8000 — 16 MP, narrow enough to pass any width check', async () => {
    const r = await attempt(2000, 8000);
    expect(r.ok).toBe(false);
    expect((r as any).message).toMatch(/3000000|check|constraint/i);
  });

  it('accepts 10000x300 — a 3 MP panorama a width cap would wrongly reject', async () => {
    expect((await attempt(10000, 300)).ok).toBe(true);
  });

  it('accepts exactly 3,000,000 pixels and rejects one more', async () => {
    expect((await attempt(2000, 1500)).ok).toBe(true); // 3,000,000
    expect((await attempt(2000, 1501)).ok).toBe(false); // 3,002,000
  });

  // Stated rather than hidden. The constraint reads
  //   CHECK (width IS NULL OR height IS NULL OR width * height <= 3000000)
  // so a row whose dimensions were never recorded is unconstrained. The image
  // pipeline must always persist both dimensions or DRV-15 is not enforced.
  it('LIMITATION: the cap is skipped when either dimension is NULL', async () => {
    expect((await attempt(99999, null)).ok).toBe(true);
  });
});

describe('DRV-17: metadata only', () => {
  it('media stores a reference, not content', async () => {
    const cols = (
      await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'septic_app' AND table_name = 'media'`,
      )
    ).rows.map((r: any) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['storage_bucket', 'storage_key', 'sha256', 'byte_size']));
    expect(cols.some((c: string) => /bytea|content|data|blob/i.test(c) && c !== 'byte_size')).toBe(false);
  });
});
