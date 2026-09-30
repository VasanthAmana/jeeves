import type { NormalizedMessage, WaSourceStatus } from '../../shared/ipc-contract'

// Where a captured message came from, as WhatsApp itself knows it — what the app needs to find the
// message again and reply to it. Pure (no Electron / db), so it's unit-testable and usable from the
// migration.
//
// WhatsApp Web's message key (a row's data-id in the DOM, and `msg.id._serialized` in its store) is
//   <fromMe>_<chat JID>_<message id>[_<participant JID>]
// e.g. `false_120363041234567890@g.us_3A5F0C2B9D_919876543210@c.us` (group, incoming from a member)
// or `true_919876543210@c.us_3EB0A1B2C3D4` (1:1, sent by the user). The chat JID is WhatsApp's own
// stable id for the conversation — unlike its display name, it survives renames and tells apart two
// chats that share a name.

export interface WaMessageKey {
  fromMe: boolean
  chatJid: string
  id: string
  participant?: string // the group member who sent it (group chats only)
}

const JID_DOMAINS = ['c.us', 'g.us', 's.whatsapp.net', 'lid', 'broadcast', 'newsletter']
const JID = /^([^@\s_"'\\]+)@([a-z.]+)$/
const KEY = /^(true|false)_([^_\s"'\\]+)_([^_\s"'\\]+)(?:_([^_\s"'\\]+))?$/

/** A WhatsApp JID (`<user>@c.us`, `<id>@g.us`, `<id>@lid`, …), or null if it isn't one. */
export function asJid(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 120) return null
  const m = JID.exec(v)
  return m && JID_DOMAINS.includes(m[2]) ? v : null
}

/** Parse a WhatsApp message key (DOM data-id / store id). null for anything else (demo ids, fallbacks). */
export function parseMessageKey(dataId: string): WaMessageKey | null {
  const m = KEY.exec(dataId || '')
  if (!m) return null
  const chatJid = asJid(m[2])
  if (!chatJid) return null
  const participant = m[4] ? asJid(m[4]) : null
  if (m[4] && !participant) return null
  return { fromMe: m[1] === 'true', chatJid, id: m[3], ...(participant ? { participant } : {}) }
}

export function isGroupJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith('@g.us')
}

/** The source fields to store with a message: the chat + sender JIDs, and how sure we are of them. */
export function messageSource(msg: Pick<NormalizedMessage, 'messageId' | 'direction' | 'chatJid' | 'senderJid'>): {
  chatJid: string | null
  senderJid: string | null
  status: WaSourceStatus
} {
  const key = parseMessageKey(msg.messageId)
  const chatJid = asJid(msg.chatJid) ?? key?.chatJid ?? null
  if (!chatJid) return { chatJid: null, senderJid: null, status: 'title-only' }
  // Sender: the group member from the key, else (1:1, incoming) the chat itself. Outgoing = the user.
  const senderJid =
    msg.direction === 'outgoing' ? null : (asJid(msg.senderJid) ?? key?.participant ?? (isGroupJid(chatJid) ? null : chatJid))
  return { chatJid, senderJid, status: 'exact' }
}

/** A chat's app-side key from its display name. MUST match the recipe's slug (recipe.ts) exactly,
 *  since captured conversationIds are already slugs. */
export function slugifyTitle(t: string): string {
  return (t || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'chat'
}

const KINDS = new Set(['text', 'reply', 'system', 'reaction', 'sticker', 'media', 'notification'])

/** Harden a page-derived message: strict types, bounded text, sane fields — never trust the DOM. */
export function coerceMessage(raw: unknown): NormalizedMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.slice(0, max) : '')
  const conversationId = str(r.conversationId, 300)
  const messageId = str(r.messageId, 300)
  const text = str(r.text)
  if (!conversationId || !messageId) return null
  const direction = r.direction === 'outgoing' ? 'outgoing' : 'incoming'
  const kind = KINDS.has(r.kind as string) ? (r.kind as NormalizedMessage['kind']) : 'text'
  const ts = typeof r.timestamp === 'number' && isFinite(r.timestamp) ? r.timestamp : Date.now()
  const participants = Array.isArray(r.participants)
    ? (r.participants as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, 256).map((p) => p.slice(0, 200))
    : undefined
  // The chat JID: reported by the recipe, else recovered from the message key itself (so even an
  // older or AI-rewritten recipe that doesn't report it still yields the source).
  const chatJid = asJid(r.chatJid) ?? parseMessageKey(messageId)?.chatJid ?? undefined
  const senderJid = asJid(r.senderJid) ?? undefined
  return {
    conversationId,
    conversationTitle: str(r.conversationTitle, 300) || conversationId,
    messageId,
    from: str(r.from, 200) || (direction === 'outgoing' ? 'me' : 'unknown'),
    direction,
    text,
    timestamp: ts,
    kind,
    isGroup: !!r.isGroup || isGroupJid(chatJid),
    participants,
    ...(chatJid ? { chatJid } : {}),
    ...(senderJid ? { senderJid } : {})
  }
}
