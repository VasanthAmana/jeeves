import { BrowserWindow, session } from 'electron'
import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { whatsappConfig } from '../config/whatsapp'
import { getSetting, setSetting } from '../db/settings'
import { ingestMessage } from './observer'
import { transcribeAndIngest } from './voice'
import type { MediaContext } from './media'
import type { NormalizedMessage, WaSessionState, WaWebviewConfig } from '../../shared/ipc-contract'

// WhatsApp Web session + message source (WAC-002). DEFAULT is LIVE — the WhatsApp tab embeds
// WhatsApp Web in a renderer <webview> on a dedicated PERSISTENT partition (QR login; session
// survives restarts), and a DOM detector streams captured messages via wa:ingest → ingestMessage.
// A DEMO toggle (persisted setting `whatsapp_demo`) switches to a MOCK source that seeds a
// scripted conversation so the UI can be explored with no linked phone — mock data exists ONLY
// while demo mode is on. The active mode is a runtime setting, not an env var, so it flips in-app.
//
// The normalization boundary is ingestMessage(NormalizedMessage): nothing downstream depends
// on WhatsApp's DOM, so swapping live ↔ demo ↔ a future capture front-end changes only this
// file + the detector (recipe.ts).

const DEMO_SETTING = 'whatsapp_demo'
// The scripted demo's conversation ids — used to seed and to purge demo data on toggle-off.
export const MOCK_CONVERSATION_IDS = ['dev-team', 'john-alpha', 'family']

let state: WaSessionState = 'unauthenticated'
let started = false

/**
 * The active mode: the persisted DEMO toggle wins; otherwise the env default (`PA_WHATSAPP_MODE`,
 * set to `live` in .env so live is always on). Env is read at CALL time — the whatsappConfig const
 * is evaluated at import, before loadDotEnv runs in whenReady, so reading it here would miss .env.
 */
export function whatsappMode(): 'mock' | 'live' {
  const s = getSetting(DEMO_SETTING)
  if (s === 'true') return 'mock'
  if (s === 'false') return 'live'
  return process.env.PA_WHATSAPP_MODE === 'mock' ? 'mock' : 'live' // default LIVE
}

export function isDemo(): boolean {
  return whatsappMode() === 'mock'
}

export function sessionState(): WaSessionState {
  return whatsappMode() === 'mock' ? 'mock' : state
}

function pushState(next: WaSessionState): void {
  state = next
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('whatsapp:sessionState', { state: sessionState() })
}

/** The renderer <webview> config for the live embedded WhatsApp Web pane (disabled in demo mode). */
export function webviewConfig(): WaWebviewConfig {
  return {
    enabled: whatsappMode() === 'live',
    demo: whatsappMode() === 'mock',
    url: whatsappConfig.url,
    partition: whatsappConfig.partition,
    userAgent: whatsappConfig.userAgent
  }
}

/** The detector reports the live session's auth state (qr → linked) from the webview. */
export function reportSession(next: WaSessionState): void {
  if (whatsappMode() !== 'live') return
  if (next === state) return
  pushState(next)
}

/** Start the source for the active mode. Idempotent (per boot). */
export function startWhatsappSource(): void {
  if (started) return
  started = true
  if (whatsappMode() === 'live') startLiveSession()
  else seedMockConversations()
}

/** Persist the demo toggle + re-arm the source for the new mode. Returns the new mode's demo flag. */
export function setDemo(enabled: boolean): void {
  setSetting(DEMO_SETTING, enabled ? 'true' : 'false')
  started = true // we (re)initialise the source right here
  if (enabled) {
    seedMockConversations()
  } else {
    pushState('unauthenticated')
    startLiveSession()
  }
}

// ── Live source ──────────────────────────────────────────────────────────────────────
// Prepares the persistent partition so WhatsApp Web's cookies/storage survive restarts, and
// hardens it. The renderer mounts the <webview> on this partition — the QR renders when unlinked,
// and the injected detector streams messages via wa:ingest. No credentials touch the app.
function startLiveSession(): void {
  const part = session.fromPartition(whatsappConfig.partition)
  part.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'notifications'))
  part.setUserAgent(whatsappConfig.userAgent)
  armDownloadInterceptor(part)
  pushState('unauthenticated') // the detector reports 'qr' then 'linked' as the webview loads
}

// ── Voice-note download interception (WAC-021) ─────────────────────────────────────────────
// A voice note has no readable blob (opus is decoded in WASM), so we trigger WhatsApp's own
// "Download" on the row: the webview raises a download, which Electron surfaces on the partition's
// `will-download`. We redirect it to a temp file, read the decrypted bytes → Sarvam → English →
// ingest. The renderer arms a MediaContext (via wa:expectMediaDownload) right before it clicks
// Download; we pop the most-recent recent arm (single download at a time). Images do NOT use this
// path — they expose a full-res blob in the DOM, captured via wa:describeImage instead.
let pendingMedia: { ctx: MediaContext; at: number } | null = null
let interceptorArmed = false

/** Renderer arms the context for the voice note it is about to trigger a download for. */
export function expectMediaDownload(ctx: MediaContext): void {
  pendingMedia = { ctx, at: Date.now() }
}

/**
 * Attach the voice-note download interceptor to the WhatsApp partition. Safe to call unconditionally
 * at startup: it only acts on downloads explicitly armed via expectMediaDownload, so it must NOT be
 * gated behind the connector-connected flag (the webview + recipe run in live mode regardless).
 */
export function ensureWhatsappDownloadInterceptor(): void {
  armDownloadInterceptor(session.fromPartition(whatsappConfig.partition))
}

function armDownloadInterceptor(part: Electron.Session): void {
  if (interceptorArmed) return
  interceptorArmed = true
  part.on('will-download', (_event, item) => {
    const arm = pendingMedia && Date.now() - pendingMedia.at < 30_000 ? pendingMedia : null
    const mime = item.getMimeType() || ''
    const fname = item.getFilename() || ''
    const isAudio = /audio|opus|ogg/i.test(mime) || /\.(ogg|opus|m4a|mp3|wav|aac)$/i.test(fname)
    if (!arm || !isAudio) return // not a voice-note download we asked for — let it proceed normally
    pendingMedia = null

    // setSavePath() bypasses the save dialog and writes to our temp path; on 'done' we read the
    // decrypted bytes, transcribe, and delete the temp file. Nothing prompts the user.
    const tmp = join(tmpdir(), `wa-voice-${Date.now()}-${fname || 'clip.ogg'}`)
    item.setSavePath(tmp)
    item.once('done', (_e, stateStr) => {
      if (stateStr !== 'completed') return
      try {
        const buf = readFileSync(tmp)
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        void transcribeAndIngest(ab, mime || 'audio/ogg', arm.ctx).finally(() => {
          try {
            unlinkSync(tmp)
          } catch {
            /* best-effort cleanup */
          }
        })
      } catch {
        /* read failed */
      }
    })
  })
}

// ── Demo (mock) source ─────────────────────────────────────────────────────────────────
// A scripted conversation so the UI can be explored offline. Only seeded in demo mode. Idempotent:
// messages dedup by message_id and obligations by events UNIQUE(source, external_id).
export function seedMockConversations(): void {
  const t = Date.now()
  const min = 60_000
  const script: NormalizedMessage[] = [
    msg('dev-team', 'Development Team', 'wa_d1', 'incoming', 'Karthik', 'Can you deploy the current build by tomorrow evening?', t - 40 * min, true, ['me', 'Karthik', 'Prasanna']),
    msg('dev-team', 'Development Team', 'wa_d2', 'outgoing', 'me', 'Prasanna, can you take the deployment? Need it by tomorrow.', t - 39 * min, true, ['me', 'Karthik', 'Prasanna']),
    msg('dev-team', 'Development Team', 'wa_d3', 'incoming', 'Prasanna', 'Yes, I will complete the deployment by tomorrow evening.', t - 38 * min, true, ['me', 'Karthik', 'Prasanna']),
    msg('john-alpha', 'John — Project Alpha', 'wa_j1', 'incoming', 'John', 'Could you send the revised cost proposal? Client is waiting.', t - 20 * min, false),
    msg('john-alpha', 'John — Project Alpha', 'wa_j2', 'outgoing', 'me', "Sure, I'll send the proposal by Friday.", t - 19 * min, false),
    msg('family', 'Family', 'wa_f1', 'incoming', 'Amma', 'Dinner at 8?', t - 5 * min, true, ['me', 'Amma', 'Appa'])
  ]
  for (const m of script) ingestMessage(m)
}

function msg(
  conversationId: string,
  conversationTitle: string,
  messageId: string,
  direction: 'incoming' | 'outgoing',
  from: string,
  text: string,
  timestamp: number,
  isGroup = false,
  participants?: string[]
): NormalizedMessage {
  return { conversationId, conversationTitle, messageId, from, direction, text, timestamp, kind: 'text', isGroup, participants }
}
