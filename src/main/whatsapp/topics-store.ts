import type Database from 'better-sqlite3'
import { slugifyTitle } from './source'
import { resolveSources, topicMessages } from './store'
import type { WhatsappTopic, WhatsappTopicAction, WaTopicView, WaTopicMessage } from '../../shared/ipc-contract'

// Topic persistence (WAC-009-topics). A topic is a whole matter (title + summary + status +
// consolidated action items); each captured message is assigned to a topic (wa_messages.topic_id),
// and a topic's "conversation bits" are its assigned messages. Grouping into EXISTING topics is
// the extractor's job (it's given the current topics); user moves PIN a message so re-extraction
// won't override the correction. db-first-arg idiom, testable without Electron. Every message bit and
// every action's evidence id is hydrated with its source (exact chat + message) so it can be replied to.

interface TopicRow {
  id: string
  conversation_id: string
  conversation_title: string
  title: string
  summary: string
  status: string
  priority: string
  tags: string
  action_items: string
  updated_at: number
}

/** The existing topics for a chat (id + title + status), given to the extractor so it can group. */
export function existingTopics(db: Database.Database, conversationId: string): { id: string; title: string; status: string }[] {
  return db
    .prepare('SELECT id, title, status FROM wa_topics WHERE conversation_id = ? ORDER BY updated_at DESC')
    .all(conversationId) as { id: string; title: string; status: string }[]
}

/** The user's pinned message→topic-title corrections, so the extractor keeps them put. */
export function pinnedAssignments(db: Database.Database, conversationId: string): { messageId: string; topicTitle: string }[] {
  const rows = db
    .prepare(
      `SELECT m.message_id AS messageId, t.title AS topicTitle
       FROM wa_messages m JOIN wa_topics t ON t.id = m.topic_id
       WHERE m.conversation_id = ? AND m.topic_pinned = 1`
    )
    .all(conversationId) as { messageId: string; topicTitle: string }[]
  return rows
}

/** Upsert one topic + assign its (non-pinned) messages. Returns the resolved topic id. */
export function upsertTopic(db: Database.Database, conversationId: string, conversationTitle: string, topic: WhatsappTopic, now: number): string {
  const id = topic.id && topic.id.startsWith(conversationId + ':') ? topic.id : `${conversationId}:${slugifyTitle(topic.title)}`
  db.prepare(
    `INSERT INTO wa_topics (id, conversation_id, conversation_title, title, summary, status, priority, tags, action_items, evidence, created_at, updated_at)
     VALUES (@id, @cid, @ctitle, @title, @summary, @status, @priority, @tags, @actions, @evidence, @now, @now)
     ON CONFLICT(id) DO UPDATE SET conversation_title=@ctitle, title=@title, summary=@summary, status=@status,
       priority = CASE WHEN priority_locked = 1 THEN priority ELSE @priority END,
       tags = CASE WHEN tags_locked = 1 THEN tags ELSE @tags END,
       action_items=@actions, evidence=@evidence, updated_at=@now`
  ).run({
    id,
    cid: conversationId,
    ctitle: conversationTitle,
    title: topic.title,
    summary: topic.summary ?? '',
    status: ['open', 'waiting', 'resolved'].includes(topic.status) ? topic.status : 'open',
    priority: ['low', 'normal', 'high'].includes(topic.priority) ? topic.priority : 'normal',
    tags: JSON.stringify(topic.tags ?? []),
    actions: JSON.stringify(topic.actionItems ?? []),
    evidence: JSON.stringify(topic.messageIds ?? []),
    now
  })
  // Assign the message bits to this topic — but never move a PINNED (user-corrected) message.
  const assign = db.prepare(`UPDATE wa_messages SET topic_id = ? WHERE conversation_id = ? AND message_id = ? AND topic_pinned = 0`)
  for (const mid of topic.messageIds ?? []) assign.run(id, conversationId, mid)
  return id
}

function hydrate(db: Database.Database, row: TopicRow): WaTopicView {
  const messages: WaTopicMessage[] = topicMessages(db, row.id).map((m) => ({
    message_id: m.message_id,
    direction: m.direction,
    sender: m.sender,
    text: m.text,
    timestamp: m.timestamp,
    pinned: m.pinned,
    source: m.source
  }))
  let stored: WhatsappTopicAction[] = []
  try {
    const a = JSON.parse(row.action_items || '[]')
    stored = Array.isArray(a) ? a : []
  } catch {
    stored = []
  }
  const actions: WaTopicView['action_items'] = stored.map((a) => ({
    ...a,
    evidence: resolveSources(db, row.conversation_id, Array.isArray(a.evidence_message_ids) ? a.evidence_message_ids : [])
  }))
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    conversation_title: row.conversation_title,
    title: row.title,
    summary: row.summary,
    status: row.status,
    priority: row.priority,
    tags: parseTags(row.tags),
    action_items: actions,
    messages,
    updated_at: row.updated_at
  }
}

function parseTags(v: string): string[] {
  try {
    const a = JSON.parse(v || '[]')
    return Array.isArray(a) ? a.map(String) : []
  } catch {
    return []
  }
}

export function listTopics(db: Database.Database): WaTopicView[] {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, conversation_title, title, summary, status, priority, tags, action_items, updated_at
       FROM wa_topics ORDER BY updated_at DESC`
    )
    .all() as TopicRow[]
  return rows.map((r) => hydrate(db, r))
}

/** Manual priority — locks the field so re-extraction won't overwrite it. */
export function setTopicPriority(db: Database.Database, topicId: string, priority: 'low' | 'normal' | 'high'): void {
  db.prepare('UPDATE wa_topics SET priority = ?, priority_locked = 1, updated_at = ? WHERE id = ?').run(priority, Date.now(), topicId)
}

/** Manual tags — normalised + locked so re-extraction won't overwrite them. */
export function setTopicTags(db: Database.Database, topicId: string, tags: string[]): void {
  const clean = [...new Set(tags.map((t) => String(t).trim().toLowerCase().slice(0, 24)).filter(Boolean))].slice(0, 8)
  db.prepare('UPDATE wa_topics SET tags = ?, tags_locked = 1, updated_at = ? WHERE id = ?').run(JSON.stringify(clean), Date.now(), topicId)
}

/** Move a message bit to another topic (existing id) or a brand-new topic (title); pins it. */
export function moveMessage(db: Database.Database, messageId: string, target: { topicId?: string; newTitle?: string }, now: number): boolean {
  const msg = db.prepare('SELECT conversation_id, conversation_id AS cid FROM wa_messages WHERE message_id = ?').get(messageId) as
    | { conversation_id: string }
    | undefined
  if (!msg) return false
  const cid = msg.conversation_id
  let topicId = target.topicId
  if (!topicId && target.newTitle) {
    // Create the new topic (empty digest — it re-summarises on the next extraction pass).
    const ctitle = (db.prepare('SELECT title FROM wa_conversations WHERE id = ?').get(cid) as { title: string } | undefined)?.title ?? ''
    topicId = upsertTopic(db, cid, ctitle, { id: '', title: target.newTitle, summary: '', status: 'open', priority: 'normal', tags: [], actionItems: [], messageIds: [] }, now)
  }
  if (!topicId) return false
  db.prepare('UPDATE wa_messages SET topic_id = ?, topic_pinned = 1 WHERE message_id = ?').run(topicId, messageId)
  db.prepare('UPDATE wa_topics SET updated_at = ? WHERE id = ?').run(now, topicId)
  return true
}

export function clearTopics(db: Database.Database): void {
  db.prepare('DELETE FROM wa_topics').run()
}
