import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from './migrations.js';

/**
 * Opens (creating if needed) the local SQLite database and brings its schema
 * up to date (see migrations.ts). WAL mode keeps reads and writes from
 * blocking each other, which matters once the collection runner and a UI
 * are both touching the database at once.
 */
export function openDatabase(filePath: string): Database.Database {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
