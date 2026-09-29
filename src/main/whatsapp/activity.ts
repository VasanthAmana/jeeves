import type Database from 'better-sqlite3'
import { ritualClass, normalizeForCluster } from './ingest/classify'
import type { WaActivityView } from '../../shared/ipc-contract'

// "Group activity" collapse (WAC — ritual clubbing). Rebuilds a conversation's wa_activity from a
// recent window: ritual/greeting messages (and any short text repeated across many senders) are
// grouped and reduced to ONE frequency-counted line — "🎂 32 wished happy birthday" — instead of
// polluting topics. Pure heuristic (no LLM), so the batch can run cheaply on a timer + on demand.

const ACTIVITY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000 // last 3 days
const RITUAL_MIN_SENDERS = 2 // a known ritual clubs once ≥2 people join in
const CLUSTER_MIN_SENDERS = 3 // a novel (non-template) repeat needs a higher bar to avoid false clubs

interface Group {
  kind: string
  emoji: string
  label: string
  isRitual: boolean
  senders: Set<string>
  msgs: number
  first: number
  last: number
}

/** Rebuild wa_activity for one conversation from its recent messages. */
export function collapseActivity(db: Database.Database, conversationId: string, conversationTitle: string): void {
  const since = Date.now() - ACTIVITY_WINDOW_MS
  const rows = db
    .prepare(`SELECT sender, text, timestamp FROM wa_messages WHERE conversation_id = ? AND direction = 'incoming' AND text <> '' AND timestamp >= ? ORDER BY timestamp`)
    .all(conversationId, since) as { sender: string | null; text: string; timestamp: number }[]

  const groups = new Map<string, Group>()
  for (const m of rows) {
    const ritual = ritualClass(m.text)
    let key: string
    let g0: Omit<Group, 'senders' | 'msgs' | 'first' | 'last'>
    if (ritual) {
      key = 'ritual:' + ritual.kind
      g0 = { kind: ritual.kind, emoji: ritual.emoji, label: ritual.label, isRitual: true }
    } else {
      const norm = normalizeForCluster(m.text)
      const letters = norm.replace(/[^a-z0-9]/g, '')
      if (letters.length < 2 || letters.length > 25) continue // only SHORT repeats are cluster candidates
      key = 'cluster:' + norm
      g0 = { kind: 'cluster', emoji: '💬', label: m.text.trim().slice(0, 40), isRitual: false }
    }
    let g = groups.get(key)
    if (!g) {
      g = { ...g0, senders: new Set(), msgs: 0, first: m.timestamp, last: m.timestamp }
      groups.set(key, g)
    }
    g.senders.add((m.sender || '?').trim())
    g.msgs++
    if (m.timestamp < g.first) g.first = m.timestamp
    if (m.timestamp > g.last) g.last = m.timestamp
  }

  const now = Date.now()
  const keep: { id: string; key: string; g: Group }[] = []
  for (const [key, g] of groups) {
    const sc = g.senders.size
    if (g.isRitual ? sc < RITUAL_MIN_SENDERS : sc < CLUSTER_MIN_SENDERS) continue
    keep.push({ id: conversationId + ':' + key, key, g })
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM wa_activity WHERE conversation_id = ?').run(conversationId)
    const ins = db.prepare(
      `INSERT INTO wa_activity (id, conversation_id, conversation_title, kind, emoji, label, sender_count, msg_count, senders, first_ts, last_ts, updated_at)
       VALUES (@id, @cid, @title, @kind, @emoji, @label, @sc, @mc, @senders, @first, @last, @now)`
    )
    for (const { id, g } of keep) {
      ins.run({
        id,
        cid: conversationId,
        title: conversationTitle,
        kind: g.kind,
        emoji: g.emoji,
        label: g.label,
        sc: g.senders.size,
        mc: g.msgs,
        senders: JSON.stringify([...g.senders].slice(0, 6)),
        first: g.first,
        last: g.last,
        now
      })
    }
  })
  tx()
}

/** All group-activity items (optionally for one conversation), busiest first. */
export function listActivity(db: Database.Database, conversationId?: string): WaActivityView[] {
  const rows = (
    conversationId
      ? db.prepare('SELECT * FROM wa_activity WHERE conversation_id = ? ORDER BY sender_count DESC, last_ts DESC').all(conversationId)
      : db.prepare('SELECT * FROM wa_activity ORDER BY conversation_id, sender_count DESC, last_ts DESC').all()
  ) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: String(r.id),
    conversationId: String(r.conversation_id),
    conversationTitle: String(r.conversation_title || ''),
    kind: String(r.kind),
    emoji: String(r.emoji || '💬'),
    label: String(r.label),
    senderCount: Number(r.sender_count || 0),
    msgCount: Number(r.msg_count || 0),
    senders: safeArr(r.senders),
    lastTs: Number(r.last_ts || 0)
  }))
}

function safeArr(v: unknown): string[] {
  try {
    const a = JSON.parse(String(v ?? '[]'))
    return Array.isArray(a) ? a.map(String) : []
  } catch {
    return []
  }
}
