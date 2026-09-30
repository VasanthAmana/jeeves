import { ipcMain, BrowserWindow } from 'electron'
import { getDb } from '../db'
import { listConversations, getConversation, setExcluded, clearWhatsapp } from '../whatsapp/store'
import { resolveReplyTarget } from '../whatsapp/reply'
import { draftReply } from '../whatsapp/draft'
import { ingestMessage, runAnalysisBatch, sweepProgress } from '../whatsapp/observer'
import { coerceMessage } from '../whatsapp/source'
import { listActivity } from '../whatsapp/activity'
import { sessionState, webviewConfig, reportSession, setDemo, expectMediaDownload, MOCK_CONVERSATION_IDS } from '../whatsapp/session'
import { transcribeAndIngest } from '../whatsapp/voice'
import { describeImageAndIngest } from '../whatsapp/media'
import { getRecipe, rollbackRecipe } from '../whatsapp/recipe'
import { healRecipe } from '../whatsapp/heal'
import { getSelectors, healSelectors, resetSelectors, type SelectorKey } from '../whatsapp/selectors'
import { getIncludeList, setIncludeList, includedSlugs } from '../whatsapp/scope'
import { listTopics, moveMessage, clearTopics, setTopicPriority, setTopicTags } from '../whatsapp/topics-store'
import type { WaReplyTarget, WaSessionState, WaSweepEvent } from '../../shared/ipc-contract'

// WhatsApp IPC surface. Read-oriented: list/read chats, toggle per-chat exclusions, delete all
// indexed data, and STAGE a draft reply (never sends). The renderer never touches a cloud API
// or the WhatsApp session directly — everything crosses the typed bridge. seedMock is a dev
// affordance to inject the scripted demo on demand.

function broadcast(channel: string, payload: Record<string, unknown> = {}): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

export function registerWhatsappHandlers(): void {
  ipcMain.handle('wa:sessionState', () => ({ state: sessionState() }))
  ipcMain.handle('wa:listChats', () => listConversations(getDb()))
  ipcMain.handle('wa:getConversation', (_e, id: string) => getConversation(getDb(), id))

  ipcMain.handle('wa:setExcluded', (_e, id: string, excluded: boolean) => {
    setExcluded(getDb(), id, excluded)
    broadcast('whatsapp:messagesChanged')
    return { ok: true as const }
  })

  ipcMain.handle('wa:clearAll', () => {
    clearTopics(getDb())
    clearWhatsapp(getDb())
    broadcast('whatsapp:messagesChanged')
    broadcast('whatsapp:topicsChanged')
    return { ok: true as const }
  })

  ipcMain.handle('wa:draftReply', async (_e, conversationId: string) => {
    try {
      const { draft } = await draftReply(getDb(), conversationId)
      return { ok: true as const, draft }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Reply to one exact message (or just the chat): resolve where it lives from the stored source and
  // draft a reply to it. The renderer stages the plan in WhatsApp Web; nothing is ever sent from here.
  ipcMain.handle('wa:prepareReply', async (_e, target: WaReplyTarget) => {
    try {
      const db = getDb()
      const r = resolveReplyTarget(db, target)
      if (!r.ok) return { ok: false as const, error: r.error }
      const { draft } = await draftReply(db, r.dest.conversationId, r.dest.quote)
      return { ok: true as const, plan: { ...r.dest, draft } }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Live embedded WhatsApp Web ──────────────────────────────────────────────────
  ipcMain.handle('wa:webviewConfig', () => webviewConfig())

  // Chat-sweep progress: the renderer reports each step; main owns the counts (see progress.ts).
  ipcMain.handle('wa:sweepEvent', (_e, raw: unknown) => {
    const ev = coerceSweepEvent(raw)
    return ev ? sweepProgress.event(ev) : sweepProgress.snapshot()
  })
  ipcMain.handle('wa:sweepProgress', () => sweepProgress.snapshot())

  // The DOM detector (running in the WhatsApp <webview>) streams captured messages here. This
  // payload is UNTRUSTED page-derived data — validate/coerce it into a NormalizedMessage before
  // it touches the store or the extractor. ingestMessage does the rest of the pipeline.
  ipcMain.handle('wa:ingest', (_e, raw: unknown) => {
    const msg = coerceMessage(raw)
    if (msg) ingestMessage(msg)
    return { ok: !!msg }
  })

  // Transcribe a captured voice note via Sarvam, then ingest the transcript as a message (kind
  // 'voice') so topic extraction reads it. Audio leaves the device for Sarvam — respects the
  // same untrusted-content stance; excluded/out-of-scope chats are already dropped by ingestMessage.
  // In-band capture path: renderer already has the audio bytes (rare — most voice notes have no
  // readable blob). Delegates to the same Sarvam → English → ingest helper as the download path.
  ipcMain.handle('wa:transcribeAudio', async (_e, payload: { conversationId: string; conversationTitle: string; messageId: string; from: string; direction: 'incoming' | 'outgoing'; timestamp: number; isGroup?: boolean; audio: string; mime?: string }) => {
    try {
      if (!payload?.audio) return { ok: false as const }
      const buf = Buffer.from(payload.audio, 'base64')
      if (!buf.length || buf.length > 8_000_000) return { ok: false as const }
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      const ok = await transcribeAndIngest(ab, payload.mime ?? 'audio/ogg', { ...payload, mediaKind: 'voice' })
      return { ok }
    } catch {
      return { ok: false as const }
    }
  })

  // Voice download path: arm the voice note's context, then the renderer triggers WhatsApp's own
  // Download on the row. Electron's will-download interceptor (session.ts) reads the decrypted
  // file and runs Sarvam → English → ingest.
  ipcMain.handle('wa:expectMediaDownload', (_e, ctx: { conversationId: string; conversationTitle: string; messageId: string; from: string; direction: 'incoming' | 'outgoing'; timestamp: number; isGroup?: boolean; mediaKind: 'voice' | 'image' }) => {
    expectMediaDownload({
      conversationId: ctx.conversationId,
      conversationTitle: ctx.conversationTitle,
      messageId: ctx.messageId,
      from: ctx.from,
      direction: ctx.direction === 'outgoing' ? 'outgoing' : 'incoming',
      timestamp: typeof ctx.timestamp === 'number' ? ctx.timestamp : Date.now(),
      isGroup: !!ctx.isGroup,
      mediaKind: ctx.mediaKind === 'image' ? 'image' : 'voice'
    })
    return { ok: true as const }
  })

  // Image path: the renderer fetched the DOM blob and shipped its base64. Describe it via a vision
  // model (Claude-Code-first) and ingest the description as a message. Untrusted content: any text
  // in the image is evidence to summarise, never an instruction.
  ipcMain.handle('wa:describeImage', async (_e, payload: { conversationId: string; conversationTitle: string; messageId: string; from: string; direction: 'incoming' | 'outgoing'; timestamp: number; isGroup?: boolean; image: string; mime?: string }) => {
    try {
      if (!payload?.image) return { ok: false as const }
      const buf = Buffer.from(payload.image, 'base64')
      if (!buf.length || buf.length > 12_000_000) return { ok: false as const }
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      const ok = await describeImageAndIngest(ab, payload.mime ?? 'image/jpeg', {
        conversationId: payload.conversationId,
        conversationTitle: payload.conversationTitle,
        messageId: payload.messageId,
        from: payload.from,
        direction: payload.direction === 'outgoing' ? 'outgoing' : 'incoming',
        timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
        isGroup: !!payload.isGroup,
        mediaKind: 'image'
      })
      return { ok }
    } catch {
      return { ok: false as const }
    }
  })

  ipcMain.handle('wa:reportSession', (_e, state: WaSessionState) => {
    if (state === 'qr' || state === 'linked' || state === 'unauthenticated') reportSession(state)
    return { ok: true as const }
  })

  // Demo toggle. Enabling seeds mock chats; disabling purges the demo data (only the seeded
  // conversations — any REAL captures are preserved) and returns to the live embedded WhatsApp.
  ipcMain.handle('wa:setDemo', (_e, enabled: boolean) => {
    if (!enabled) clearMockData()
    setDemo(!!enabled)
    broadcast('whatsapp:messagesChanged')
    broadcast('whatsapp:sessionState', { state: sessionState() })
    return webviewConfig()
  })

  // ── Extraction recipe + AI self-heal ────────────────────────────────────────────
  ipcMain.handle('wa:getRecipe', () => ({ recipe: getRecipe() }))
  ipcMain.handle('wa:heal', async (_e, diag: string, error?: string) => {
    const r = await healRecipe(String(diag ?? ''), error)
    return r ? { ok: true as const, recipe: r.recipe, engine: r.engine } : { ok: false as const }
  })
  ipcMain.handle('wa:rollbackRecipe', () => ({ recipe: rollbackRecipe() }))

  // ── Healable ACTION selectors (open/compose/@mention/send/media) ─────────────────────
  ipcMain.handle('wa:getSelectors', () => ({ selectors: getSelectors() }))
  ipcMain.handle('wa:healSelectors', async (_e, failing: string[], diag: string) => {
    const r = await healSelectors((Array.isArray(failing) ? failing : []) as SelectorKey[], String(diag ?? ''))
    return { selectors: r.selectors, healed: r.healed, engine: r.engine }
  })
  ipcMain.handle('wa:resetSelectors', (_e, key?: string) => ({ selectors: resetSelectors(key as SelectorKey | undefined) }))

  // ── Group activity (ritual clubbing) + on-demand analysis batch ──────────────────────
  ipcMain.handle('wa:listActivity', () => ({ activity: listActivity(getDb()) }))
  ipcMain.handle('wa:refreshAnalysis', () => {
    runAnalysisBatch()
    return { ok: true as const }
  })

  // ── Topics ────────────────────────────────────────────────────────
  ipcMain.handle('wa:listTopics', () => ({ topics: listTopics(getDb()) }))
  ipcMain.handle('wa:moveMessage', (_e, messageId: string, target: { topicId?: string; newTitle?: string }) => {
    const ok = moveMessage(getDb(), String(messageId), target ?? {}, Date.now())
    broadcast('whatsapp:topicsChanged')
    return { ok }
  })
  ipcMain.handle('wa:setTopicPriority', (_e, topicId: string, priority: 'low' | 'normal' | 'high') => {
    setTopicPriority(getDb(), String(topicId), ['low', 'normal', 'high'].includes(priority) ? priority : 'normal')
    broadcast('whatsapp:topicsChanged')
    return { ok: true as const }
  })
  ipcMain.handle('wa:setTopicTags', (_e, topicId: string, tags: string[]) => {
    setTopicTags(getDb(), String(topicId), Array.isArray(tags) ? tags : [])
    broadcast('whatsapp:topicsChanged')
    return { ok: true as const }
  })
  // Assign-in-WhatsApp: assignable people for a group = distinct incoming senders we've captured
  // (excludes the user + 'unknown'). The live @mention resolves the real participant at send time.
  ipcMain.handle('wa:groupParticipants', (_e, conversationId: string) => {
    const db = getDb()
    const conv = db.prepare('SELECT is_group FROM wa_conversations WHERE id = ?').get(String(conversationId)) as { is_group: number } | undefined
    const rows = db
      .prepare(`SELECT DISTINCT sender FROM wa_messages WHERE conversation_id = ? AND direction = 'incoming' AND sender IS NOT NULL AND sender != '' ORDER BY sender`)
      .all(String(conversationId)) as { sender: string }[]
    const participants = rows.map((r) => r.sender).filter((s) => s && !['me', 'unknown'].includes(s.toLowerCase()))
    return { participants, isGroup: !!conv?.is_group }
  })

  // ── Inclusion allow-list ─────────────────────────────────────────────────
  ipcMain.handle('wa:getInclude', () => ({ titles: getIncludeList() }))
  ipcMain.handle('wa:setInclude', (_e, titles: string[]) => {
    setIncludeList(Array.isArray(titles) ? titles.map((t) => String(t)) : [])
    purgeOutOfScope()
    broadcast('whatsapp:messagesChanged')
    return { ok: true as const, titles: getIncludeList() }
  })
}

/** When an allow-list is set, drop captured data (chats/messages/topics) for any conversation no
 *  longer in scope, so the app reflects "only these chats". No-op if list empty. */
function purgeOutOfScope(): void {
  const slugs = includedSlugs()
  if (slugs.size === 0) return
  const db = getDb()
  const keep = [...slugs]
  const notIn = `(${keep.map(() => '?').join(',')})`
  db.transaction(() => {
    db.prepare(`DELETE FROM wa_topics WHERE conversation_id NOT IN ${notIn}`).run(...keep)
    db.prepare(`DELETE FROM wa_messages WHERE conversation_id NOT IN ${notIn}`).run(...keep)
    db.prepare(`DELETE FROM wa_conversations WHERE id NOT IN ${notIn}`).run(...keep)
  })()
}

/** Purge only the seeded demo conversations, leaving real data intact. */
function clearMockData(): void {
  const db = getDb()
  const ids = MOCK_CONVERSATION_IDS
  const placeholders = ids.map(() => '?').join(',')
  db.transaction(() => {
    db.prepare(`DELETE FROM wa_messages WHERE conversation_id IN (${placeholders})`).run(...ids)
    db.prepare(`DELETE FROM wa_conversations WHERE id IN (${placeholders})`).run(...ids)
  })()
}

/** A renderer-reported sweep step, strictly typed (the renderer is trusted, but keep main's state sane). */
function coerceSweepEvent(raw: unknown): WaSweepEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0)
  const str = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 300) : '')
  switch (r.type) {
    case 'start':
      return { type: 'start', limit: num(r.limit) }
    case 'found':
      return { type: 'found', count: num(r.count), ...(typeof r.total === 'number' ? { total: num(r.total) } : {}) }
    case 'opening':
      return { type: 'opening', title: str(r.title) }
    case 'read':
      return { type: 'read', title: str(r.title) }
    case 'end':
      return { type: 'end', stopped: !!r.stopped, ...(r.note ? { note: str(r.note) } : {}) }
    default:
      return null
  }
}

export function cleanupWhatsappHandlers(): void {
  for (const ch of [
    'wa:sessionState',
    'wa:listChats',
    'wa:getConversation',
    'wa:setExcluded',
    'wa:clearAll',
    'wa:draftReply',
    'wa:prepareReply',
    'wa:webviewConfig',
    'wa:ingest',
    'wa:sweepEvent',
    'wa:sweepProgress',
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
  ]) {
    ipcMain.removeHandler(ch)
  }
}
