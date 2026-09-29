import type Database from 'better-sqlite3'
import { recentMessages } from '../store'
import { keepForAnalysis } from './prefilter'
import { ritualClass } from './classify'
import type { NormalizedMessage } from '../../../shared/ipc-contract'

// Conversation-window construction — the analysis unit. A window is a focused, bounded slice
// of a chat: participants + a run of recent, pre-filtered messages, each carrying its
// messageId so the extractor can cite it (evidence_message_ids). The window is what the
// extractor sees — never the whole history.

export interface WindowMessage {
  messageId: string
  sender: string
  direction: 'incoming' | 'outgoing'
  text: string
  timestamp: number
}

export interface ConversationWindow {
  conversationId: string
  conversationTitle: string
  participants: string[]
  messages: WindowMessage[]
}

const MAX_WINDOW_MESSAGES = 40

/** Build the analysis window for a conversation from its recent, pre-filtered messages. */
export function buildWindow(
  db: Database.Database,
  conversationId: string,
  conversationTitle: string,
  participants: string[]
): ConversationWindow {
  // recentMessages is already oldest→newest; map to NormalizedMessage-ish for the shared filter.
  const rows = recentMessages(db, conversationId, MAX_WINDOW_MESSAGES * 2)
  const kept = rows
    .map(
      (m): NormalizedMessage => ({
        conversationId,
        conversationTitle,
        messageId: m.message_id,
        from: m.sender ?? (m.direction === 'outgoing' ? 'me' : 'unknown'),
        direction: m.direction,
        text: m.text,
        timestamp: m.timestamp,
        kind: (m.kind as NormalizedMessage['kind']) ?? 'text'
      })
    )
    .filter(keepForAnalysis)
    .filter((m) => !ritualClass(m.text)) // rituals/greetings live in the activity digest, not topics
    .slice(-MAX_WINDOW_MESSAGES)

  return {
    conversationId,
    conversationTitle,
    participants,
    messages: kept.map((m) => ({
      messageId: m.messageId,
      sender: m.from,
      direction: m.direction,
      text: m.text,
      timestamp: m.timestamp
    }))
  }
}

/** Render a window as the delimited evidence block the extractor reads (untrusted, WAC-016). */
export function renderWindow(win: ConversationWindow): string {
  const header = `Chat: ${win.conversationTitle}\nParticipants: ${win.participants.join(', ') || '(unknown)'}\n`
  const lines = win.messages.map(
    (m) => `[${m.messageId}] ${m.direction === 'outgoing' ? 'me' : m.sender}: ${m.text}`
  )
  return header + '\n' + lines.join('\n')
}
