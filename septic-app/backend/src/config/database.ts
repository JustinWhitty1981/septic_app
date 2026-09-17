import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '5432'),
  username: process.env.DATABASE_USER || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'postgres',
  database: process.env.DATABASE_NAME || 'septic',
  schema: 'septic_app',
  synchronize: false, // Never auto-sync. The schema is SQL, in db/migrations.
  logging: process.env.NODE_ENV === 'development',
  entities: [process.env.NODE_ENV === 'production' ? 'dist/models/*.js' : 'src/models/*.ts'],
  // Intentionally empty, and NOT an oversight. Migrations here are versioned raw SQL
  // in db/migrations/, applied by `npm run migrate` (scripts/migrate.ts).
  //
  // They must stay out of TypeORM's migrator for two reasons:
  //   1. The target schema uses generated columns, views, functions, enums and partial
  //      unique indexes -- all things TypeORM's query builder cannot express.
  //   2. `entities` above glob-loads src/models/*.ts. Those entities now describe this
  //      schema, and tests/entity-schema.test.ts fails the build if they stop doing so —
  //      but agreement about *columns* is not agreement about *how a table is built*.
  //      Generating from them would still lose the generated-column expression, the view
  //      definitions and the partial unique indexes, and could emit a DROP for any of
  //      them. That is why `migration:generate` was removed from package.json rather than
  //      left in place, and it stays removed now that the entities are honest.
  migrations: [],
  ssl: false, // Disable SSL for Docker/development
});
