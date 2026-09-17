import { Client } from 'pg';
import { connect } from './db';

/**
 * Every entity must describe a table that exists, with columns that exist.
 *
 * This suite exists because of a specific, expensive failure. The models in
 * src/models/ were written against the pre-rewrite schema and kept compiling
 * perfectly while the database changed underneath them. Nothing failed at build
 * time, nothing at startup, nothing in review — because a TypeORM entity is a plain
 * class and TypeScript has no idea what SQL is.
 *
 * It only appeared when a human logged in and clicked something:
 *
 *   GET /api/customers  ->  relation "septic_app.customers" does not exist
 *   GET /api/properties ->  column property.address does not exist
 *
 * Thirteen entities, nine pointing at deleted tables, two at tables whose columns
 * had all been renamed, and a suite that stayed green because it never asked the
 * database whether the entities were true. So this asks.
 */
let db: Client;
let entities: any[] = [];

beforeAll(async () => {
  db = await connect();
  const { AppDataSource } = require('../src/config/database');
  if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  entities = AppDataSource.entityMetadatas;
});

afterAll(async () => {
  await db?.end();
  const { AppDataSource } = require('../src/config/database');
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
});

const q = async (sql: string, params: any[] = []) => (await db.query(sql, params)).rows;

/** table_name -> set of column names, for every base table in septic_app. */
async function realSchema(): Promise<Map<string, Set<string>>> {
  const rows = await q(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'septic_app'`,
  );
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!m.has(r.table_name)) m.set(r.table_name, new Set());
    m.get(r.table_name)!.add(r.column_name);
  }
  return m;
}

describe('NF-06: entities are downstream of the schema, not beside it', () => {
  it('the DataSource actually loaded entities', () => {
    // Without this the assertions below pass vacuously on a broken glob or a
    // renamed models directory — the exact failure mode that hid this bug.
    expect(entities.length).toBeGreaterThan(10);
  });

  it('every entity maps to a table that exists', async () => {
    const have = await q(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'septic_app' AND table_type = 'BASE TABLE'`,
    );
    const tables = new Set(have.map((r) => r.table_name));
    const ghosts = entities.map((e) => e.tableName)
      .filter((t: string) => !tables.has(t)).sort();
    expect(ghosts).toEqual([]);
  });

  it('every mapped column exists in its table', async () => {
    const schema = await realSchema();
    const bad: string[] = [];
    for (const e of entities) {
      const cols = schema.get(e.tableName);
      if (!cols) continue; // already reported as a ghost table
      for (const c of e.columns) {
        if (!cols.has(c.databaseName)) {
          bad.push(`${e.name}.${c.propertyName} -> ${e.tableName}.${c.databaseName}`);
        }
      }
    }
    expect(bad.sort()).toEqual([]);
  });

  it('no entity claims a column twice', async () => {
    // Two properties mapped to one column compile, load, and then corrupt writes in
    // whichever order TypeORM happens to iterate.
    const bad: string[] = [];
    for (const e of entities) {
      const seen = new Map<string, string>();
      for (const c of e.columns) {
        if (seen.has(c.databaseName)) {
          bad.push(`${e.tableName}.${c.databaseName}: ${seen.get(c.databaseName)} and ${c.propertyName}`);
        }
        seen.set(c.databaseName, c.propertyName);
      }
    }
    expect(bad.sort()).toEqual([]);
  });
});

describe('NF-06: an entity can actually write the row it claims to', () => {
  it('maps every NOT NULL column that has no other source of a value', async () => {
    // The inverse of the check above, and the one that bites later. A column the
    // entity never mentions is harmless while it is nullable or defaulted; when it
    // is NOT NULL with no default, every INSERT through that entity fails at runtime
    // with a message the client must never see (NF-11).
    const rows = await q(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'septic_app' AND t.table_type = 'BASE TABLE'
          AND c.is_nullable = 'NO'
          AND c.column_default IS NULL
          AND c.is_generated = 'NEVER'`,
    );
    const mapped = new Set<string>();
    for (const e of entities) {
      for (const c of e.columns) mapped.add(`${e.tableName}.${c.databaseName}`);
    }
    const known = new Set(entities.map((e) => e.tableName));
    const unmapped = rows
      .filter((r) => known.has(r.table_name))
      .map((r) => `${r.table_name}.${r.column_name}`)
      .filter((k) => !mapped.has(k))
      .sort();
    expect(unmapped).toEqual([]);
  });
});

describe('NF-06: named Postgres enums are named correctly', () => {
  it('every enum the entities reference exists in the database', async () => {
    // Postgres stores a type per enum, and TypeORM derives the name from
    // table_column unless you pass enumName. `users_role_enum` is not what migration
    // 0001 created — it created `user_role` — and the difference is an INSERT that
    // fails with "type does not exist" on the first write anybody makes, long after
    // the entity passed review.
    const have = await q(
      `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'septic_app' AND t.typtype = 'e'`,
    );
    const dbEnums = new Set(have.map((r) => r.typname));
    const used = new Set<string>();
    for (const e of entities) {
      for (const c of e.columns) if (c.enumName) used.add(c.enumName);
    }
    expect([...used].filter((n) => !dbEnums.has(n)).sort()).toEqual([]);
  });

  it('every enum value an entity offers is actually allowed', async () => {
    // A TypeScript union wider than the enum is a compile-time lie: the code tries
    // to write 'overdue', Postgres refuses, and the requirement fails in production
    // rather than here. Invoice.status was exactly this.
    const rows = await q(
      `SELECT t.typname, e.enumlabel FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'septic_app'`,
    );
    const allowed = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!allowed.has(r.typname)) allowed.set(r.typname, new Set());
      allowed.get(r.typname)!.add(r.enumlabel);
    }
    const bad: string[] = [];
    for (const e of entities) {
      for (const c of e.columns) {
        if (!c.enumName || !c.enum) continue;
        const ok = allowed.get(c.enumName);
        if (!ok) continue; // reported by the test above
        for (const v of c.enum) if (!ok.has(v)) bad.push(`${c.enumName}.${v}`);
      }
    }
    expect([...new Set(bad)].sort()).toEqual([]);
  });
});
