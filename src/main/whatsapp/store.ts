import type Database from 'better-sqlite3'
import type { NormalizedMessage, WaConversationView, WaMessageSource, WaMessageView, WaSourceStatus } from '../../shared/ipc-contract'
import { messageSource } from './source'

// WhatsApp raw-capture persistence. Functions take the db handle so the SQL is unit-testable
// without an Electron context. Conversations + messages are the raw observation substrate;
// extracted obligations ride the topic digest (topics-store.ts), never a table here. Message
// dedup is UNIQUE(conversation_id, message_id); re-capturing a rendered message is an
// INSERT OR IGNORE no-op. Each message keeps its source (chat JID + sender JID, see source.ts) so it
// can be found and replied to later; resolveSource/resolveSources turn stored ids back into that.

interface WaConversationRow {
  id: string
  title: string
  is_group: number
  participants: string
  excluded: number
  last_seen_at: number | null
}

interface WaMessageRow {
  conversation_id: string
  chat_title: string | null
  message_id: string
  direction: 'incoming' | 'outgoing'
  sender: string | null
  text: string
  kind: string
  timestamp: number
  chat_jid: string | null
  sender_jid: string | null
  source_status: string
}

// The message columns + its chat's current display name — everything a WaMessageSource needs.
const MESSAGE_COLS = `m.conversation_id, c.title AS chat_title, m.message_id, m.direction, m.sender, m.text, m.kind,
  m.timestamp, m.chat_jid, m.sender_jid, m.source_status`
const MESSAGE_FROM = 'wa_messages m LEFT JOIN wa_conversations c ON c.id = m.conversation_id'

const STATUSES: WaSourceStatus[] = ['exact', 'recovered', 'title-only']

function sourceOf(r: WaMessageRow): WaMessageSource {
  const status = STATUSES.includes(r.source_status as WaSourceStatus) ? (r.source_status as WaSourceStatus) : 'title-only'
  return {
    conversationId: r.conversation_id,
    chatTitle: r.chat_title || r.conversation_id,
    chatJid: r.chat_jid,
    messageId: r.message_id,
    sender: r.sender,
    senderJid: r.sender_jid,
    direction: r.direction,
    text: r.text,
    timestamp: r.timestamp,
    status
  }
}

function viewOf(r: WaMessageRow): WaMessageView {
  return {
    message_id: r.message_id,
    direction: r.direction,
    sender: r.sender ?? undefined,
    text: r.text,
    kind: r.kind,
    timestamp: r.timestamp,
    source: sourceOf(r)
  }
}

/** Upsert a conversation from a captured message; returns whether the chat is excluded. */
export function upsertConversation(db: Database.Database, msg: NormalizedMessage, now: number): boolean {
  db.prepare(
    `INSERT INTO wa_conversations (id, title, is_group, participants, excluded, last_seen_at, created_at, chat_jid)
     VALUES (@id, @title, @is_group, @participants, 0, @ts, @now, @chat_jid)
     ON CONFLICT(id) DO UPDATE SET title = @title, is_group = @is_group,
       participants = CASE WHEN @participants != '[]' THEN @participants ELSE participants END,
       last_seen_at = @ts, chat_jid = COALESCE(@chat_jid, chat_jid)`
  ).run({
    id: msg.conversationId,
    title: msg.conversationTitle,
    is_group: msg.isGroup ? 1 : 0,
    participants: JSON.stringify(msg.participants ?? []),
    ts: msg.timestamp,
    now,
    chat_jid: messageSource(msg).chatJid
  })
  const row = db.prepare('SELECT excluded FROM wa_conversations WHERE id = ?').get(msg.conversationId) as
    | { excluded: number }
    | undefined
  return !!row?.excluded
}

/** Persist a captured message (dedup by conversation+message id). Returns true if newly inserted. */
export function insertMessage(db: Database.Database, msg: NormalizedMessage, now: number): boolean {
  const src = messageSource(msg)
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO wa_messages
         (conversation_id, message_id, direction, sender, text, kind, timestamp, created_at, chat_jid, sender_jid, source_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(msg.conversationId, msg.messageId, msg.direction, msg.from, msg.text, msg.kind, msg.timestamp, now, src.chatJid, src.senderJid, src.status)
  return Number(info.changes) > 0
}

/** Recent messages for a conversation, oldest→newest (the window/pane substrate). */
export function recentMessages(db: Database.Database, conversationId: string, limit = 60): WaMessageView[] {
  const rows = db
    .prepare(`SELECT ${MESSAGE_COLS} FROM ${MESSAGE_FROM} WHERE m.conversation_id = ? ORDER BY m.timestamp DESC LIMIT ?`)
    .all(conversationId, limit) as WaMessageRow[]
  return rows.map(viewOf).reverse()
}

/** Messages assigned to a topic, oldest→newest, each with its source. */
export function topicMessages(db: Database.Database, topicId: string): (WaMessageView & { pinned: boolean })[] {
  const rows = db
    .prepare(`SELECT ${MESSAGE_COLS}, m.topic_pinned FROM ${MESSAGE_FROM} WHERE m.topic_id = ? ORDER BY m.timestamp ASC`)
    .all(topicId) as (WaMessageRow & { topic_pinned: number })[]
  return rows.map((r) => ({ ...viewOf(r), pinned: !!r.topic_pinned }))
}

/** The stored source of one message in a chat — its exact chat + message — or null if unknown. */
export function resolveSource(db: Database.Database, conversationId: string, messageId: string): WaMessageSource | null {
  const row = db
    .prepare(`SELECT ${MESSAGE_COLS} FROM ${MESSAGE_FROM} WHERE m.conversation_id = ? AND m.message_id = ?`)
    .get(conversationId, messageId) as WaMessageRow | undefined
  return row ? sourceOf(row) : null
}

/** Resolve evidence ids (e.g. a topic action's evidence_message_ids) to their sources, in order;
 *  ids that don't resolve to a stored message in this chat are dropped. */
export function resolveSources(db: Database.Database, conversationId: string, messageIds: readonly string[]): WaMessageSource[] {
  const out: WaMessageSource[] = []
  for (const id of new Set(messageIds)) {
    const s = resolveSource(db, conversationId, id)
    if (s) out.push(s)
  }
  return out
}

/** The chat's identity for reopening it: display name + WhatsApp chat JID (null if never reported). */
export function conversationSource(db: Database.Database, conversationId: string): { title: string; chatJid: string | null } | null {
  const row = db.prepare('SELECT title, chat_jid FROM wa_conversations WHERE id = ?').get(conversationId) as
    | { title: string; chat_jid: string | null }
    | undefined
  return row ? { title: row.title, chatJid: row.chat_jid } : null
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
