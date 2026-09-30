import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from './schema'
import { migrate } from './migrate'

// Single local SQLite handle for the app's operational state. better-sqlite3 is a
// native module externalized by electron-vite; it runs only in the main process.

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db
  const file = join(app.getPath('userData'), 'jeeves.db')
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  migrate(db)
  _db = db
  return db
}

export function closeDb(): void {
  _db?.close()
  _db = null
}
