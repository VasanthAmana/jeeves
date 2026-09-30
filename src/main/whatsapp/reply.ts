import type Database from 'better-sqlite3'
import { conversationSource, isExcluded, resolveSource } from './store'
import type { WaReplyPlan, WaReplyTarget } from '../../shared/ipc-contract'

// Where a reply goes: a reply target (a chat, optionally one exact message) resolved against the
// stored source into everything the renderer needs to stage it — the chat's display name and
// WhatsApp chat id, and the message to quote. The draft text is added by the caller (draft.ts) —
// which sends the chat to a model, so an excluded chat (WAC-015) is refused here.

export type ReplyDestination = Omit<WaReplyPlan, 'draft'>

export function resolveReplyTarget(
  db: Database.Database,
  target: WaReplyTarget | null | undefined
): { ok: true; dest: ReplyDestination } | { ok: false; error: string } {
  const conversationId = String(target?.conversationId ?? '')
  const chat = conversationSource(db, conversationId)
  if (!chat) return { ok: false, error: 'That chat is no longer stored.' }
  if (isExcluded(db, conversationId)) return { ok: false, error: 'This chat is excluded from analysis, so no reply is drafted for it.' }
  const quote = target?.messageId ? resolveSource(db, conversationId, String(target.messageId)) : null
  if (target?.messageId && !quote) return { ok: false, error: 'That message is no longer stored.' }
  // Prefer the chat the message itself was captured in (a renamed or same-named chat can't mislead it).
  return { ok: true, dest: { conversationId, chatTitle: chat.title, chatJid: quote?.chatJid ?? chat.chatJid, quote } }
}
