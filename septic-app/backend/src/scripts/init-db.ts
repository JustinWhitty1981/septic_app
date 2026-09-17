import { AppDataSource } from '../config/database';

async function initDB() {
  try {
    console.log('Connecting to database...');
    await AppDataSource.initialize();
    
    console.log('Synchronizing schema (one-time only)...');
    // This will create all tables based on entities
    await AppDataSource.synchronize(true);
    
    console.log('Database initialized successfully!');
    console.log('Tables created:', AppDataSource.entityMetadatas.map(e => e.tableName));
    
    await AppDataSource.destroy();
  } catch (err: any) {
    console.error('Error initializing database:', err.message);
    process.exit(1);
  }
}

initDB();
