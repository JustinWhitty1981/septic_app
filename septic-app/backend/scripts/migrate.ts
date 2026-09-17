/**
 * The one migration runner.
 *
 * Replaces seven competing ad-hoc paths. The previous version of this file read
 * DB_HOST / DB_DATABASE / DB_PASSWORD while docker-compose provides DATABASE_HOST /
 * DATABASE_NAME / DATABASE_PASSWORD, and it hard-coded a single file
 * (migrations/001-create-schema.sql), so it could not run against this environment
 * at all.
 *
 * Deliberately uses `pg` directly rather than the TypeORM DataSource. A migration runner
 * must not depend on the schema it is migrating: initialising the DataSource builds
 * metadata for all 18 entities, and a runner built on it could not apply the migration
 * that creates a table one of those entities maps to. (It used to have a second reason —
 * the entities described a schema that no longer existed. tests/entity-schema.test.ts
 * makes that impossible now, but the ordering argument above stands on its own.)
 *
 *   npm run migrate            apply anything not yet applied
 *   npm run migrate -- status  show what is applied and what is pending
 *
 * Each file runs inside its own transaction and is recorded with a sha256 of its
 * contents. If an already-applied file later changes, this exits non-zero rather
 * than quietly pretending the database matches the code.
 */

import { Client } from 'pg';
import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const SCHEMA = 'septic_app';
const TABLE = `${SCHEMA}.schema_migrations`;
const DIR = join(__dirname, '..', 'db', 'migrations');

interface Applied {
    filename: string;
    checksum: string;
}

function config() {
    return {
        host: process.env.DATABASE_HOST || 'localhost',
        port: parseInt(process.env.DATABASE_PORT || '5432', 10),
        database: process.env.DATABASE_NAME || 'septic',
        user: process.env.DATABASE_USER || 'septic_dev',
        password: process.env.DATABASE_PASSWORD || 'septic_dev_pw',
    };
}

function filesOnDisk(): string[] {
    return readdirSync(DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
}

function checksum(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function main(): Promise<number> {
    const wantStatus = process.argv.slice(2).includes('status');
    const cfg = config();
    const client = new Client(cfg);
    await client.connect();

    try {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
        await client.query(`SET search_path TO ${SCHEMA}, pg_catalog`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS ${TABLE} (
                id          serial PRIMARY KEY,
                filename    text NOT NULL UNIQUE,
                checksum    char(64) NOT NULL,
                applied_at  timestamptz NOT NULL DEFAULT now()
            )`);

        const appliedRows = await client.query(
            `SELECT filename, checksum FROM ${TABLE} ORDER BY filename`);
        const applied = new Map<string, string>(
            appliedRows.rows.map((r: Applied) => [r.filename, r.checksum]));

        const files = filesOnDisk();
        const pending: string[] = [];
        const drift: string[] = [];

        for (const f of files) {
            const sum = checksum(join(DIR, f));
            const known = applied.get(f);
            if (known === undefined) pending.push(f);
            else if (known !== sum) drift.push(f);
        }

        if (drift.length) {
            console.error('\nDRIFT: these migrations are applied but their contents changed:');
            drift.forEach((f) => console.error(`  ! ${f}`));
            console.error('\nA migration is immutable once applied. Add a new one instead.');
            return 1;
        }

        if (wantStatus) {
            console.log(`\n${SCHEMA} migrations (${files.length} on disk)\n`);
            for (const f of files) {
                const row = appliedRows.rows.find((r: Applied) => r.filename === f);
                console.log(`  ${row ? 'applied' : 'PENDING'}  ${f}`);
            }
            console.log(`\n${applied.size} applied, ${pending.length} pending.\n`);
            return 0;
        }

        if (!pending.length) {
            console.log(`schema ${SCHEMA} is up to date (${applied.size} migrations).`);
            return 0;
        }

        console.log(`applying ${pending.length} migration(s) to ${cfg.database}...`);
        for (const f of pending) {
            const sql = readFileSync(join(DIR, f), 'utf8');
            /**
             * The atomicity default, and the one statement class that cannot
             * live inside it: ALTER TYPE ... ADD VALUE refuses to run in a
             * transaction (it is catalog surgery with a cache-invalidation
             * rule attached). A file that needs one says so in a header
             * comment and accepts the trade: no rollback, and it must be
             * re-runnable — which IF NOT EXISTS (PG12+) provides. The default
             * for every other file stays BEGIN/COMMIT, because the immutability
             * guarantee below is only worth something if a failed file leaves
             * nothing behind.
             */
            const noTransaction = /^--\s*runner:\s*no-transaction/m.test(sql);
            if (noTransaction) {
                await client.query(sql);
                await client.query(
                    `INSERT INTO ${TABLE} (filename, checksum) VALUES ($1, $2)`,
                    [f, checksum(join(DIR, f))]);
                console.log(`  ok    ${f} (no transaction)`);
                continue;
            }
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query(
                    `INSERT INTO ${TABLE} (filename, checksum) VALUES ($1, $2)`,
                    [f, checksum(join(DIR, f))]);
                await client.query('COMMIT');
                console.log(`  ok    ${f}`);
            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`  FAILED ${f}`);
                throw err;
            }
        }

        const tables = await client.query(`
            SELECT count(*)::int AS n FROM information_schema.tables
            WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [SCHEMA]);
        const views = await client.query(`
            SELECT count(*)::int AS n FROM information_schema.views
            WHERE table_schema = $1`, [SCHEMA]);
        console.log(
            `\ndone. ${tables.rows[0].n} tables, ${views.rows[0].n} views in ${SCHEMA}.`);
        return 0;
    } finally {
        await client.end();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error('migration failed:', err.message || err);
        if (err.detail) console.error('detail:', err.detail);
        if (err.code) console.error('pg code:', err.code);
        process.exit(1);
    });

