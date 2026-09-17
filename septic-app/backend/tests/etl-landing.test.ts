import { Client } from 'pg';
import { connect } from './db';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The legacy landing zone — docs/REQUIREMENTS.md ETL-01, ETL-05, ETL-07.
 *
 * These assert facts about rows already in the database, loaded on the host by
 * etl/load_legacy.py. They deliberately do not run the loader: the container has no
 * docker CLI and no `data/`, and a suite that re-lands 76,088 rows every run is a
 * suite people stop running.
 *
 * What they do prove is the part that is invisible in review — that the source
 * landed in the *app's* database rather than a sidecar, that the BOM and the mixed
 * line endings did not leak into a single one of the ~700,000 values, and that the
 * content hash the idempotency guard is built on actually measures something.
 */

/** docs/DATA_MODEL.md §14, re-measured. `wc -l` disagrees with every one of these. */
const LANDED: Record<string, number> = {
  tblcustdumplog: 48216,
  tblcustomers: 7541,
  tblbilling: 7572,
  tblinvoiceamount: 6590,
  tblinvoices: 3283,
  tblinspectiondate: 2771,
  tblinvoicedetails: 99,
  tblowner: 7,
  tblwastetypes: 9,
};
const TOTAL = Object.values(LANDED).reduce((a, b) => a + b, 0);

// Same rule as etl.test.ts: absent CSVs mean a fresh clone, which is a reason
// to skip; a clone has no landing zone to assert facts about.
const CANDIDATES = [
  '/data',                                        // the container's read-only mount
  path.resolve(__dirname, '../../..', 'data'),    // running jest on the host
];
const DATA_DIR = CANDIDATES.find((d) => fs.existsSync(path.join(d, 'tblCustDumpLog.csv')));
const suite = DATA_DIR !== undefined ? describe : describe.skip;

/** Byte-for-byte the loader's checksum, so the test measures the same quantity. */
const hashOf = async (db: Client, table: string): Promise<string> => {
  const { rows } = await db.query(
    `SELECT md5(string_agg(x::text, E'\\n' ORDER BY x::text)) AS h FROM legacy.${table} x`
  );
  return rows[0].h;
};

let db: Client;
beforeAll(async () => { db = await connect(); });
afterAll(async () => { await db.end(); });

suite('ETL-07: the source landed in the app database', () => {
  it('has legacy and septic_app in the same database', async () => {
    const { rows } = await db.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name IN ('legacy', 'septic_app') ORDER BY 1`
    );
    expect(rows.map((r) => r.schema_name)).toEqual(['legacy', 'septic_app']);
  });

  // Existence is the weak form. The requirement exists because a transform must
  // share a transaction with the rows it writes, and only a cross-schema statement
  // proves that reachability. On the old split server this query was impossible.
  it('reaches legacy and septic_app in one statement', async () => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n
       FROM legacy.tblcustdumplog l
       LEFT JOIN septic_app.properties p ON p.legacy_cust_number::text = l.cust_number`
    );
    expect(rows[0].n).toBe(LANDED.tblcustdumplog);
  });

  it('landed every file at its profiled row count', async () => {
    const wrong: string[] = [];
    for (const [table, want] of Object.entries(LANDED)) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM legacy.${table}`);
      if (rows[0].n !== want) wrong.push(`${table}: got ${rows[0].n}, profiled ${want}`);
    }
    expect(wrong).toEqual([]);
  });

  it('landed the whole corpus, 76,088 rows', async () => {
    const { rows } = await db.query(`SELECT sum(row_count)::int AS n FROM legacy.load_manifest`);
    expect(rows[0].n).toBe(TOTAL);
  });

  // The legacy shared plaintext password is discarded by design (DATA_MODEL §12).
  // Landing it would put a credential in a database the app can read.
  it('did not import the legacy shared password', async () => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'legacy' AND table_name = 'tblsystem'`
    );
    expect(rows[0].n).toBe(0);
  });
});

suite('ETL-05: BOM and mixed line endings did not leak', () => {
  it('gave every column a clean identifier', async () => {
    // An unstripped BOM folds into the first column's name — the failure that looks
    // fine until the first SELECT tries to reference it.
    const { rows } = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'legacy' AND column_name !~ '^[a-z0-9_]+$'`
    );
    expect(rows).toEqual([]);
  });

  it('left no carriage return in any value', async () => {
    const cols = await db.query(
      `SELECT table_name,
              string_agg(quote_ident(column_name), '||chr(1)||' ORDER BY ordinal_position) AS allcols
       FROM information_schema.columns
       WHERE table_schema = 'legacy'
       GROUP BY table_name`
    );
    const dirty: string[] = [];
    for (const c of cols.rows) {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM legacy.${c.table_name}
         WHERE ${c.allcols} LIKE '%'||chr(13)||'%'`
      );
      if (rows[0].n > 0) dirty.push(`${c.table_name}: ${rows[0].n} values contain CR`);
    }
    expect(dirty).toEqual([]);
  });

  // The positive half. 28,870 physical lines hold 7,541 records because Memo and
  // Tank Location carry newlines inside quoted fields. A parser that split on
  // newlines would have produced 28,870 rows and zero memos containing one.
  it('kept newlines that were inside quoted fields', async () => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM legacy.tblcustomers
       WHERE memo LIKE '%'||chr(10)||'%'`
    );
    expect(rows[0].n).toBeGreaterThan(1000);
  });
});

suite('ETL-01: the load is idempotent', () => {
  it('recorded a content hash for every landed file', async () => {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM legacy.load_manifest`);
    expect(rows[0].n).toBe(Object.keys(LANDED).length);
  });

  it('still matches a freshly computed hash for every table', async () => {
    const rows = (await db.query(
      `SELECT table_name, row_count, checksum
       FROM legacy.load_manifest ORDER BY table_name`
    )).rows;
    const stale: string[] = [];
    for (const r of rows) {
      const live = await hashOf(db, r.table_name);
      const n = (await db.query(`SELECT count(*)::int AS n FROM legacy.${r.table_name}`)).rows[0].n;
      if (live !== r.checksum) stale.push(`${r.table_name}: hash moved`);
      else if (n !== r.row_count) stale.push(`${r.table_name}: row count moved`);
    }
    expect(stale).toEqual([]);
  });

  // The guard is only worth having if it can fail. A hash that cannot tell two
  // different datasets apart would report "idempotent" forever.
  it('detects a change to a single cell', async () => {
    const before = await hashOf(db, 'tblwastetypes');
    await db.query('BEGIN');
    try {
      await db.query(
        `UPDATE legacy.tblwastetypes
            SET types_of_waste = types_of_waste || '!'
          WHERE types_of_waste = (SELECT min(types_of_waste) FROM legacy.tblwastetypes)`
      );
      expect(await hashOf(db, 'tblwastetypes')).not.toBe(before);
    } finally {
      await db.query('ROLLBACK');
    }
    expect(await hashOf(db, 'tblwastetypes')).toBe(before);
  });
});
