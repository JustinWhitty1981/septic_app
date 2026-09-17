import { Client } from 'pg';
import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { connect } from './db';

/**
 * NF-05 — a migration that has been applied is immutable.
 *
 * scripts/migrate.ts stores a sha256 of each file and exits 1 on mismatch. This
 * asserts the same thing from the outside, so the guarantee is checked by the test
 * suite rather than only by whoever happens to run `npm run migrate` next.
 */
const MIGRATIONS = join(__dirname, '..', 'db', 'migrations');

// Same input as migrate.ts: the raw bytes of the file, no normalisation.
const checksum = (name: string) =>
  createHash('sha256').update(readFileSync(join(MIGRATIONS, name))).digest('hex');

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db?.end();
});

describe('NF-05: an applied migration can never be edited', () => {
  it('recomputes every recorded checksum and finds no drift', async () => {
    const rows = (
      await db.query('SELECT filename, checksum FROM septic_app.schema_migrations ORDER BY filename')
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    const drifted = rows.filter((r: any) => checksum(r.filename) !== r.checksum);
    expect(drifted.map((d: any) => d.filename)).toEqual([]);
  });

  it('has every file on disk recorded as applied', async () => {
    const onDisk = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    const rows = (
      await db.query('SELECT filename FROM septic_app.schema_migrations ORDER BY filename')
    ).rows.map((r: any) => r.filename);
    expect(rows).toEqual(onDisk);
  });

  it('checksums are 64 hex characters', async () => {
    const rows = (await db.query('SELECT checksum FROM septic_app.schema_migrations')).rows;
    for (const r of rows) expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('NF-06: the schema is versioned SQL, not ORM-generated', () => {
  it('the DataSource declares no TypeORM migrations', () => {
    const body = readFileSync(join(__dirname, '..', 'src', 'config', 'database.ts'), 'utf8');
    expect(body).toMatch(/migrations:\s*\[\s*\]/);
  });

  it('the migration:generate script is gone, so nobody can re-enable it by habit', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    const scripts = Object.keys(pkg.scripts);
    expect(scripts.filter((s) => /migration:generate|migration:revert/.test(s))).toEqual([]);
  });
});
