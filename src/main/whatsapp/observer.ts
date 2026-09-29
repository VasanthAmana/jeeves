import { EventEmitter } from 'node:events'
import { BrowserWindow } from 'electron'
import { getDb } from '../db'
import { upsertConversation, insertMessage, isExcluded } from './store'
import { keepForAnalysis } from './ingest/prefilter'
import { ritualClass } from './ingest/classify'
import { buildWindow } from './ingest/window'
import { extractWhatsappTopics } from './analysis'
import { existingTopics, pinnedAssignments, upsertTopic } from './topics-store'
import { collapseActivity } from './activity'
import { isIncluded } from './scope'
import type { NormalizedMessage } from '../../shared/ipc-contract'

// WhatsApp observation pipeline (WAC-004 / WAC-009-topics). On each captured message we: (1)
// persist it (dedup), (2) refresh the chat list, (3) — for in-scope, non-excluded chats past the
// pre-filter — debounce a window extraction, and (4) produce TOPIC digests (a whole matter with a
// title + summary + consolidated action items), grouping messages into existing topics and
// keeping user-pinned moves. The unit is the topic, not a ticket per message.

// Kept for the (now-dormant) pipeline subscription; topics replaced the per-obligation event path.
export const whatsappObservations = new EventEmitter()

// Per-conversation debounce so a burst of messages becomes ONE window analysis, not N.
const EXTRACT_DEBOUNCE_MS = 2500
const pending = new Map<string, NodeJS.Timeout>()

function broadcast(channel: string): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, {})
}

/** Ingest one captured message: persist it and (unless excluded/noise) schedule extraction. */
export function ingestMessage(msg: NormalizedMessage): void {
  // Inclusion allow-list (WAC-015): when set, ONLY listed chats are ingested at all — anything
  // else is dropped here, so non-scope chats are never stored, analysed, or shown.
  if (!isIncluded(msg.conversationId)) return

  const db = getDb()
  const now = Date.now()
  const excluded = upsertConversation(db, msg, now)
  const isNew = insertMessage(db, msg, now)
  broadcast('whatsapp:messagesChanged')

  // WAC-015: an excluded chat is stored (so the exclude toggle can show it) but never analysed.
  if (excluded || !isNew) return
  if (!keepForAnalysis(msg)) return // WAC-005 cheap tier

  // Ritual/greeting messages (birthday wishes, good-morning, festival greetings, thanks) don't
  // become topics — they collapse into the "group activity" digest (rebuilt by the analysis batch).
  // Mark the row so it's visible as ritual; buildWindow keeps them out of topic extraction too.
  if (ritualClass(msg.text)) {
    // Mark it so it's kept out of topic windows; the digest is (re)built by the analysis batch
    // (fixed 15-min timer + on-demand Refresh), not per-message — a birthday burst is 30+ messages.
    db.prepare("UPDATE wa_messages SET analysis_class = 'ritual' WHERE conversation_id = ? AND message_id = ?").run(msg.conversationId, msg.messageId)
    return
  }

  scheduleExtraction(msg.conversationId, msg.conversationTitle, msg.participants ?? [])
}

// ── Scheduled + on-demand analysis batch ──────────────────────────────────────────────────
// A fixed-interval pass (plus wa:refreshAnalysis on demand) that rebuilds the group-activity digest
// for every in-scope, non-excluded conversation. Cheap (pure heuristic, no LLM), so a 15-min cadence
// is fine. Topics stay incremental (extracted per burst on ingest, above); this keeps the ritual
// counts current and reconciles them across the whole recent window.
const BATCH_INTERVAL_MS = 15 * 60 * 1000
let batchTimer: NodeJS.Timeout | null = null

export function runAnalysisBatch(): void {
  const db = getDb()
  const convs = db.prepare('SELECT id, title FROM wa_conversations WHERE excluded = 0').all() as { id: string; title: string }[]
  for (const c of convs) {
    if (!isIncluded(c.id)) continue // honour the allow-list
    try {
      collapseActivity(db, c.id, c.title)
    } catch {
      /* one bad conversation shouldn't stop the batch */
    }
  }
  broadcast('whatsapp:topicsChanged')
}

/** Start the fixed-interval analysis batch (idempotent). Runs once now (for already-captured
 *  messages), then every 15 min. Called once at boot. */
export function startAnalysisBatch(): void {
  if (batchTimer) return
  try {
    runAnalysisBatch()
  } catch {
    /* first run over an empty/new db is fine */
  }
  batchTimer = setInterval(() => runAnalysisBatch(), BATCH_INTERVAL_MS)
}

export function stopAnalysisBatch(): void {
  if (batchTimer) clearInterval(batchTimer)
  batchTimer = null
}

function scheduleExtraction(conversationId: string, title: string, participants: string[]): void {
  const existing = pending.get(conversationId)
  if (existing) clearTimeout(existing)
  pending.set(
    conversationId,
    setTimeout(() => {
      pending.delete(conversationId)
      void extractConversation(conversationId, title, participants)
    }, EXTRACT_DEBOUNCE_MS)
  )
}

/** Build the window, extract TOPIC digests (grouping into existing topics), and upsert them.
 *  The unit is the topic — a whole matter with a title + summary + consolidated action items —
 *  not a ticket per message. Messages are assigned to their topic; user-pinned moves are kept. */
async function extractConversation(conversationId: string, title: string, participants: string[]): Promise<void> {
  const db = getDb()
  if (isExcluded(db, conversationId)) return // could have been excluded during the debounce

  const win = buildWindow(db, conversationId, title, participants)
  if (!win.messages.length) return

  const { topics } = await extractWhatsappTopics(win, existingTopics(db, conversationId), pinnedAssignments(db, conversationId))
  const now = Date.now()
  for (const topic of topics) upsertTopic(db, conversationId, title, topic, now)

  broadcast('whatsapp:messagesChanged')
  broadcast('whatsapp:topicsChanged')
}

/** Cancel pending debounced extractions (on quit). */
export function stopWhatsappObserver(): void {
  for (const t of pending.values()) clearTimeout(t)
  pending.clear()
}
