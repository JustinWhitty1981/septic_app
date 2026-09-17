import { Client } from 'pg';

/**
 * A plain pg client, deliberately not the TypeORM DataSource.
 *
 * These suites assert facts about the schema. Going through the ORM would mean an
 * entity has to exist for the thing being checked, which is backwards: the schema
 * is the source of truth and the entities are downstream of it (see NF-06).
 */
export async function connect(): Promise<Client> {
  const db = new Client({
    host: process.env.DATABASE_HOST || 'postgres',
    port: Number(process.env.DATABASE_PORT || 5432),
    user: process.env.DATABASE_USER || 'septic_dev',
    password: process.env.DATABASE_PASSWORD || 'septic_dev_pw',
    database: process.env.DATABASE_NAME || 'septic',
  });
  await db.connect();
  await db.query('SET search_path TO septic_app, public');
  return db;
}
