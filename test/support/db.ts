// A real SQLite database for the store tests. The app's better-sqlite3 is rebuilt for Electron's
// ABI (postinstall), so it can't load under plain Node; node:sqlite speaks the same prepare/run/get/
// all API the store code uses.
import { DatabaseSync } from 'node:sqlite'
import type Database from 'better-sqlite3'
import { SCHEMA_SQL } from '../../src/main/db/schema.ts'
import { migrate } from '../../src/main/db/migrate.ts'

export type Db = Database.Database

/** A fresh database exactly as the app opens one: current schema, then migrations. */
export function freshDb(): Db {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  migrate(db as unknown as Db)
  return db as unknown as Db
}

/** An empty in-memory database (to lay down an older build's schema by hand). */
export function rawDb(): Db {
  return new DatabaseSync(':memory:') as unknown as Db
}
