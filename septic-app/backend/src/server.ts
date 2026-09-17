import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as fs from 'fs';
import * as path from 'path';
import { AppDataSource } from './config/database';
import routes from './routes';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
// The 100 KB ceiling every endpoint keeps for its own protection, with one
// named exception: base64 photos. `/api/media` brings its own 16 MB parser on
// the upload route (see routes/media.ts), so the global one must stand aside
// for that path — the first parser to consume the stream owns it, and a larger
// limit mounted later is decoration.
const json = express.json({ limit: '100kb' });
app.use((req, res, next) => (
  req.path === '/api/media' || req.path.startsWith('/api/media/')
    ? next() : json(req, res, next)
));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api', routes);

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

/**
 * Compare db/migrations/*.sql on disk against septic_app.schema_migrations in the
 * database. Warns rather than exits: a developer mid-edit should not be locked out,
 * but must not be told everything is fine either.
 *
 * Degrades gracefully when db/migrations is not shipped into the image -- the check
 * then reports what is recorded rather than claiming nothing is pending.
 */
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

async function assertSchemaMigrated(): Promise<void> {
    const bookkeeping = await AppDataSource.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'septic_app'
            AND table_name   = 'schema_migrations'`);

    if (!bookkeeping.length) {
        console.warn(
            '⚠  septic_app.schema_migrations does not exist -- this schema has never '
            + 'been migrated. Run: npm run migrate');
        return;
    }

    const applied = await AppDataSource.query(
        'SELECT filename FROM septic_app.schema_migrations ORDER BY filename');
    const names = new Set<string>(applied.map((r: { filename: string }) => r.filename));

    if (!fs.existsSync(MIGRATIONS_DIR)) {
        console.log(`✅ Schema migrated (${names.size} migrations recorded)`);
        return;
    }

    const onDisk = fs.readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    const pending = onDisk.filter((f) => !names.has(f));

    if (pending.length) {
        console.warn(
            `⚠  ${pending.length} of ${onDisk.length} migrations NOT applied `
            + `(first: ${pending[0]}). Run: npm run migrate`);
    } else {
        console.log(`✅ Schema up to date (${names.size} migrations)`);
    }
}

// Start server
const startServer = async () => {
  try {
    // Initialize database connection
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
      console.log('✅ Database connected successfully');
    }

    // Migrations are an explicit deploy step, never a side effect of boot.
    //
    // This used to call AppDataSource.runMigrations(), which ran ZERO migrations --
    // the DataSource's `migrations` array is empty -- while logging
    // "Running database migrations... / Migrations completed". Boot output that
    // claims work it never did is how a stale schema hides. It was also a trap: if
    // anyone ever populated that array with a TypeORM migration generated from the
    // still-stale src/models, restarting the dev server would silently mutate schema.
    //
    // So: don't migrate here. Verify the SQL migrations in db/migrations have been
    // applied, and say so plainly if they have not.
    await assertSchemaMigrated();

    // Start server
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

export default app;
