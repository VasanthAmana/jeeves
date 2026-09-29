import type Database from 'better-sqlite3'
import type { NormalizedMessage, WaConversationView, WaMessageView } from '../../shared/ipc-contract'

// WhatsApp raw-capture persistence. Functions take the db handle so the SQL is unit-testable
// without an Electron context. Conversations + messages are the raw observation substrate;
// extracted obligations ride the topic digest (topics-store.ts), never a table here. Message
// dedup is UNIQUE(conversation_id, message_id); re-capturing a rendered message is an
// INSERT OR IGNORE no-op.

interface WaConversationRow {
  id: string
  title: string
  is_group: number
  participants: string
  excluded: number
  last_seen_at: number | null
}

interface WaMessageRow {
  message_id: string
  direction: 'incoming' | 'outgoing'
  sender: string | null
  text: string
  kind: string
  timestamp: number
}

/** Upsert a conversation from a captured message; returns whether the chat is excluded. */
export function upsertConversation(db: Database.Database, msg: NormalizedMessage, now: number): boolean {
  db.prepare(
    `INSERT INTO wa_conversations (id, title, is_group, participants, excluded, last_seen_at, created_at)
     VALUES (@id, @title, @is_group, @participants, 0, @ts, @now)
     ON CONFLICT(id) DO UPDATE SET title = @title, is_group = @is_group,
       participants = CASE WHEN @participants != '[]' THEN @participants ELSE participants END,
       last_seen_at = @ts`
  ).run({
    id: msg.conversationId,
    title: msg.conversationTitle,
    is_group: msg.isGroup ? 1 : 0,
    participants: JSON.stringify(msg.participants ?? []),
    ts: msg.timestamp,
    now
  })
  const row = db.prepare('SELECT excluded FROM wa_conversations WHERE id = ?').get(msg.conversationId) as
    | { excluded: number }
    | undefined
  return !!row?.excluded
}

/** Persist a captured message (dedup by conversation+message id). Returns true if newly inserted. */
export function insertMessage(db: Database.Database, msg: NormalizedMessage, now: number): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO wa_messages
         (conversation_id, message_id, direction, sender, text, kind, timestamp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(msg.conversationId, msg.messageId, msg.direction, msg.from, msg.text, msg.kind, msg.timestamp, now)
  return info.changes > 0
}

/** Recent messages for a conversation, oldest→newest (the window/pane substrate). */
export function recentMessages(db: Database.Database, conversationId: string, limit = 60): WaMessageView[] {
  const rows = db
    .prepare(
      `SELECT message_id, direction, sender, text, kind, timestamp
       FROM wa_messages WHERE conversation_id = ?
       ORDER BY timestamp DESC LIMIT ?`
    )
    .all(conversationId, limit) as WaMessageRow[]
  return rows
    .map((r) => ({
      message_id: r.message_id,
      direction: r.direction,
      sender: r.sender ?? undefined,
      text: r.text,
      kind: r.kind,
      timestamp: r.timestamp
    }))
    .reverse()
}

export function isExcluded(db: Database.Database, conversationId: string): boolean {
  const row = db.prepare('SELECT excluded FROM wa_conversations WHERE id = ?').get(conversationId) as
    | { excluded: number }
    | undefined
  return !!row?.excluded
}

export function setExcluded(db: Database.Database, conversationId: string, excluded: boolean): void {
  db.prepare('UPDATE wa_conversations SET excluded = ? WHERE id = ?').run(excluded ? 1 : 0, conversationId)
}

function hydrateConversation(db: Database.Database, row: WaConversationRow): WaConversationView {
  const count = db
    .prepare('SELECT COUNT(*) AS n FROM wa_messages WHERE conversation_id = ?')
    .get(row.id) as { n: number }
  let participants: string[] = []
  try {
    participants = JSON.parse(row.participants || '[]') as string[]
  } catch {
    participants = []
  }
  return {
    id: row.id,
    title: row.title,
    is_group: !!row.is_group,
    participants,
    excluded: !!row.excluded,
    last_seen_at: row.last_seen_at ?? undefined,
    message_count: count.n
  }
}

export function listConversations(db: Database.Database): WaConversationView[] {
  const rows = db
    .prepare(
      `SELECT id, title, is_group, participants, excluded, last_seen_at
       FROM wa_conversations ORDER BY last_seen_at DESC NULLS LAST`
    )
    .all() as WaConversationRow[]
  return rows.map((r) => hydrateConversation(db, r))
}

export function getConversation(
  db: Database.Database,
  id: string
): { conversation: WaConversationView; messages: WaMessageView[] } | null {
  const row = db
    .prepare('SELECT id, title, is_group, participants, excluded, last_seen_at FROM wa_conversations WHERE id = ?')
    .get(id) as WaConversationRow | undefined
  if (!row) return null
  return { conversation: hydrateConversation(db, row), messages: recentMessages(db, id) }
}

// Retention: purge all indexed WhatsApp data. The derived wa_topics rows are cleared by the
// caller (clearTopics, topics-store.ts) first, so a chat leaves no trace.
export function clearWhatsapp(db: Database.Database): void {
  db.transaction(() => {
    db.prepare('DELETE FROM wa_messages').run()
    db.prepare('DELETE FROM wa_conversations').run()
  })()
}
