import type Database from 'better-sqlite3'
import { messageSource } from '../whatsapp/source'

// Additive, versioned migrations for databases created by an older build. SCHEMA_SQL (schema.ts)
// declares the CURRENT tables for a fresh database; CREATE TABLE IF NOT EXISTS leaves an existing
// table as it was, so each step here brings an older table up to that shape. Steps only ever ADD
// (columns, backfills) — an older row stays readable, it's just marked for what it lacks. The
// applied version is PRAGMA user_version. Only prepare/exec are used, so this runs on any
// better-sqlite3-compatible handle (the tests use node:sqlite).

type Db = Pick<Database.Database, 'prepare' | 'exec'>

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
}

function addColumn(db: Db, table: string, column: string, decl: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
}

const MIGRATIONS: ((db: Db) => void)[] = [
  // 1 — keep each message's source (WhatsApp chat JID + sender JID) so it can be found and replied
  // to later. Rows captured before this have none; where the stored message id is WhatsApp's own
  // message key, the chat JID is embedded in it, so recover it ('recovered'). The rest stay usable
  // and are marked 'title-only' (reopened by the chat's display name).
  (db) => {
    addColumn(db, 'wa_conversations', 'chat_jid', 'TEXT')
    addColumn(db, 'wa_messages', 'chat_jid', 'TEXT')
    addColumn(db, 'wa_messages', 'sender_jid', 'TEXT')
    addColumn(db, 'wa_messages', 'source_status', "TEXT NOT NULL DEFAULT 'title-only'")
    const rows = db.prepare("SELECT id, message_id, direction FROM wa_messages WHERE chat_jid IS NULL").all() as {
      id: number
      message_id: string
      direction: string
    }[]
    const setMsg = db.prepare("UPDATE wa_messages SET chat_jid = ?, sender_jid = ?, source_status = 'recovered' WHERE id = ?")
    for (const r of rows) {
      const src = messageSource({ messageId: r.message_id, direction: r.direction === 'outgoing' ? 'outgoing' : 'incoming' })
      if (src.chatJid) setMsg.run(src.chatJid, src.senderJid, r.id)
    }
    // A conversation's chat JID = the one its latest recovered message was captured in.
    db.exec(
      `UPDATE wa_conversations SET chat_jid = (
         SELECT m.chat_jid FROM wa_messages m
         WHERE m.conversation_id = wa_conversations.id AND m.chat_jid IS NOT NULL
         ORDER BY m.timestamp DESC LIMIT 1)
       WHERE chat_jid IS NULL`
    )
  }
]

export const SCHEMA_VERSION = MIGRATIONS.length

/** Bring the database up to SCHEMA_VERSION. Each step runs in its own transaction. */
export function migrate(db: Db): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) || 0
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      MIGRATIONS[v](db)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
}
