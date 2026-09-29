// Typed contract for the renderer↔main IPC bridge. BOTH processes import this
// (main: relative; renderer: '@shared/ipc-contract'). The preload allow-lists are
// derived from the channel arrays below, so adding a channel here is the single
// source of truth.

// ── WhatsApp Copilot (WAC) — chat messages as the observation source ────────────────
// Everything downstream of NormalizedMessage depends only on this type, never on a
// WhatsApp DOM selector — that boundary is what keeps the capture front-end swappable
// (and what the AI self-heal rewrites against, in src/main/whatsapp/recipe.ts + heal.ts).

/** The normalization boundary — one captured message, provider-agnostic. */
export interface NormalizedMessage {
  conversationId: string
  conversationTitle: string
  messageId: string
  from: string // display name / number
  direction: 'incoming' | 'outgoing' // outgoing = the user's own
  text: string
  timestamp: number // epoch ms
  kind: 'text' | 'reply' | 'system' | 'reaction' | 'sticker' | 'media' | 'notification'
  isGroup?: boolean
  participants?: string[]
}

/** The obligation taxonomy extracted from a conversation window. */
export type WhatsappItemType =
  | 'reply_required'
  | 'user_commitment'
  | 'delegated_task'
  | 'waiting_for'
  | 'meeting_date'
  | 'informational'
  | 'decision'

/** A structured obligation pulled from a chat window — carries the messages it came from. */
export interface WhatsappActionItem {
  type: WhatsappItemType
  text: string // phrased as a task, in English (becomes a ticket/todo)
  owner?: string // who owns it; 'me' for the user
  company?: string | null
  due?: string | null
  priority: 'low' | 'normal' | 'high'
  confidence: number
  evidence_message_ids: string[] // the source messages (provenance) — opens the exact chat lines
  quote?: string // representative verbatim line, original language
}

/** A conversation for the WhatsApp tab chat list (serializable). */
export interface WaConversationView {
  id: string
  title: string
  is_group: boolean
  participants: string[]
  excluded: boolean
  last_seen_at?: number
  message_count: number
}

/** One captured message for the conversation pane. */
export interface WaMessageView {
  message_id: string
  direction: 'incoming' | 'outgoing'
  sender?: string
  text: string
  kind: string
  timestamp: number
}

/** One consolidated action inside a topic. */
export interface WhatsappTopicAction {
  text: string // phrased as a task, in English
  owner?: string
  due?: string | null
  type: WhatsappItemType
}

/** A topic digest produced by extraction: a whole matter, not a single exchange. */
export interface WhatsappTopic {
  id: string // '' for a new topic; else the existing topic id to update (grouping)
  title: string
  summary: string
  status: 'open' | 'waiting' | 'resolved'
  priority: 'low' | 'normal' | 'high'
  tags: string[] // 1–3 short lowercase category tags (e.g. 'deployment', 'billing') for grouping/filtering
  actionItems: WhatsappTopicAction[]
  messageIds: string[] // the message bits that belong to this topic
}

/** A message bit shown under its topic. */
export interface WaTopicMessage {
  message_id: string
  direction: 'incoming' | 'outgoing'
  sender?: string
  text: string
  timestamp: number
  pinned: boolean // user moved it here → re-extraction won't move it
}

/** A stored topic for the Topics view: digest + its assigned message bits. */
export interface WaTopicView {
  id: string
  conversation_id: string
  conversation_title: string
  title: string
  summary: string
  status: string
  priority: string
  tags: string[]
  action_items: WhatsappTopicAction[]
  messages: WaTopicMessage[]
  updated_at: number
}

/** A collapsed "group activity" line — ritual/greeting messages clubbed with a frequency count. */
export interface WaActivityView {
  id: string
  conversationId: string
  conversationTitle: string
  kind: string // birthday | good_morning | festival | … | cluster
  emoji: string
  label: string // e.g. 'birthday wishes'
  senderCount: number // headline count: how many DISTINCT people
  msgCount: number
  senders: string[] // sample names
  lastTs: number
}

/** The WhatsApp Web session state, surfaced on the connector card. */
export type WaSessionState = 'unauthenticated' | 'qr' | 'linked' | 'mock'

/** Config the renderer needs to mount the live embedded WhatsApp Web <webview>. */
export interface WaWebviewConfig {
  enabled: boolean // true in live mode (mount the webview); false in demo mode
  demo: boolean // true when the Demo toggle is on (mock data instead of a linked phone)
  url: string
  partition: string
  userAgent: string
}

/** Request/response channels (renderer → main, awaited). */
export interface IpcInvokeChannels {
  'app:getVersion': { args: []; return: string }
  // WhatsApp Copilot (WAC). Read-oriented: list/read chats, toggle per-chat exclusions,
  // delete all indexed data. draftReply STAGES a reply (never sends).
  'wa:sessionState': { args: []; return: { state: WaSessionState } }
  'wa:listChats': { args: []; return: WaConversationView[] }
  'wa:getConversation': { args: [id: string]; return: { conversation: WaConversationView; messages: WaMessageView[] } | null }
  'wa:setExcluded': { args: [id: string, excluded: boolean]; return: { ok: boolean } }
  'wa:clearAll': { args: []; return: { ok: boolean } }
  'wa:draftReply': { args: [conversationId: string]; return: { ok: boolean; draft?: string; error?: string } }
  // Live embedded WhatsApp Web. The renderer mounts the <webview> from this config; the
  // injected DOM detector streams captured messages via wa:ingest and reports the session's
  // auth state (qr → linked) via wa:reportSession. Nothing here sends a message.
  'wa:webviewConfig': { args: []; return: WaWebviewConfig }
  'wa:ingest': { args: [message: NormalizedMessage]; return: { ok: boolean } }
  // A captured voice note. The base64 audio is transcribed via Sarvam in main, and the
  // transcript is ingested as the message text (kind 'voice') → topic extraction reads it.
  'wa:transcribeAudio': {
    args: [payload: { conversationId: string; conversationTitle: string; messageId: string; from: string; direction: 'incoming' | 'outgoing'; timestamp: number; isGroup?: boolean; audio: string; mime?: string }]
    return: { ok: boolean }
  }
  // Voice download: the renderer arms a voice note's context right before it triggers
  // WhatsApp's own "Download" on the row. Electron intercepts the resulting download on the
  // partition, reads the decrypted audio → Sarvam → English → ingest. No playing.
  'wa:expectMediaDownload': {
    args: [ctx: { conversationId: string; conversationTitle: string; messageId: string; from: string; direction: 'incoming' | 'outgoing'; timestamp: number; isGroup?: boolean; mediaKind: 'voice' | 'image' }]
    return: { ok: boolean }
  }
  // Image path: images DO expose a full-res blob in the DOM, so the renderer fetches it and
  // ships the base64 here. Main runs a vision model → a plain-English description → ingest.
  'wa:describeImage': {
    args: [payload: { conversationId: string; conversationTitle: string; messageId: string; from: string; direction: 'incoming' | 'outgoing'; timestamp: number; isGroup?: boolean; image: string; mime?: string }]
    return: { ok: boolean }
  }
  'wa:reportSession': { args: [state: WaSessionState]; return: { ok: boolean } }
  // Demo toggle: enable → seed mock data (no phone); disable → clear demo data + go live. Returns
  // the fresh webview config so the tab re-renders (mount/unmount the embedded WhatsApp Web).
  'wa:setDemo': { args: [enabled: boolean]; return: WaWebviewConfig }
  // The extraction recipe injected into the webview (recipe-as-data). Self-heal: when the
  // recipe stops capturing, the renderer sends a structure-only diagnostic and gets an
  // AI-rewritten recipe back; rollback restores the last-known-good recipe if the heal fails.
  'wa:getRecipe': { args: []; return: { recipe: string } }
  'wa:heal': { args: [diag: string, error?: string]; return: { ok: boolean; recipe?: string; engine?: string } }
  'wa:rollbackRecipe': { args: []; return: { recipe: string } }
  // Healable ACTION selectors (open/compose/@mention/send/media). The renderer uses these for
  // its WhatsApp automation; when an action can't find its target it sends a structure-only
  // diagnostic and the AI rewrites the failing selector(s). reset rolls a bad heal back to the
  // shipped default.
  'wa:getSelectors': { args: []; return: { selectors: Record<string, string> } }
  'wa:healSelectors': { args: [failing: string[], diag: string]; return: { selectors: Record<string, string>; healed: string[]; engine?: string } }
  'wa:resetSelectors': { args: [key?: string]; return: { selectors: Record<string, string> } }
  // Inclusion allow-list: analyse ONLY these chat titles; empty ⇒ all chats. Setting it purges
  // captured data for chats no longer in scope.
  'wa:getInclude': { args: []; return: { titles: string[] } }
  'wa:setInclude': { args: [titles: string[]]; return: { ok: boolean; titles: string[] } }
  // Topic digests: grouped conversations with a title + action items + status, referencing
  // their actual message bits. Move a message bit to another topic (pins it), or to a
  // brand-new topic (pass a title).
  // Assign-in-WhatsApp: the assignable people for a group = the participants we've already seen
  // speak in it. The real @mention resolves against the live group at send time.
  'wa:groupParticipants': { args: [conversationId: string]; return: { participants: string[]; isGroup: boolean } }
  'wa:listTopics': { args: []; return: { topics: WaTopicView[] } }
  // Group-activity digest (ritual clubbing) + on-demand re-run of the analysis batch (which also
  // runs on a fixed 15-min timer). refresh recomputes activity for all in-scope chats.
  'wa:listActivity': { args: []; return: { activity: WaActivityView[] } }
  'wa:refreshAnalysis': { args: []; return: { ok: boolean } }
  // Manual priority + tags on a topic. Setting either LOCKS that field so re-extraction (on new
  // messages) won't overwrite the user's choice. Tags let similar topics be grouped/filtered.
  'wa:setTopicPriority': { args: [topicId: string, priority: 'low' | 'normal' | 'high']; return: { ok: boolean } }
  'wa:setTopicTags': { args: [topicId: string, tags: string[]]; return: { ok: boolean } }
  'wa:moveMessage': { args: [messageId: string, target: { topicId?: string; newTitle?: string }]; return: { ok: boolean } }
}

/** Push channels (main → renderer, fire-and-forget). */
export interface IpcEventChannels {
  // WhatsApp: a chat/message was captured (refresh the chat list + conversation pane), and
  // the linked-session state changed (drives the connector card / QR).
  'whatsapp:messagesChanged': Record<string, never>
  'whatsapp:sessionState': { state: WaSessionState }
  'whatsapp:topicsChanged': Record<string, never>
}

export type InvokeChannel = keyof IpcInvokeChannels
export type EventChannel = keyof IpcEventChannels

export const INVOKE_CHANNELS = [
  'app:getVersion',
  'wa:sessionState',
  'wa:listChats',
  'wa:getConversation',
  'wa:setExcluded',
  'wa:clearAll',
  'wa:draftReply',
  'wa:webviewConfig',
  'wa:ingest',
  'wa:transcribeAudio',
  'wa:expectMediaDownload',
  'wa:describeImage',
  'wa:reportSession',
  'wa:setDemo',
  'wa:getRecipe',
  'wa:heal',
  'wa:rollbackRecipe',
  'wa:getSelectors',
  'wa:healSelectors',
  'wa:resetSelectors',
  'wa:getInclude',
  'wa:setInclude',
  'wa:groupParticipants',
  'wa:listActivity',
  'wa:refreshAnalysis',
  'wa:listTopics',
  'wa:setTopicPriority',
  'wa:setTopicTags',
  'wa:moveMessage'
] as const

export const EVENT_CHANNELS = [
  'whatsapp:messagesChanged',
  'whatsapp:sessionState',
  'whatsapp:topicsChanged'
] as const
