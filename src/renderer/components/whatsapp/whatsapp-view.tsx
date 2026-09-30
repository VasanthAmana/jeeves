import { useEffect, useRef, useState } from 'react'
import { invoke, on } from '@/services/ipc'
import { Analytics } from '@/lib/analytics'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { TopicsView } from './topics-view'
import { registerWaSender, type WaTaskSend } from './wa-sender'
import { createGuest, type Guest } from './guest'
import { sweepChats } from './sweep'
import * as gs from './guest-scripts'
import type { NormalizedMessage, WaConversationView, WaMessageView, WaSessionState, WaWebviewConfig } from '@shared/ipc-contract'

// The imperative bits of Electron's <webview> we call (the element is an HTMLElement subclass).
// Scripts never go through executeJavaScript directly — only via guest.ts (see there for why).
interface WaWebview {
  executeJavaScript(code: string): Promise<unknown>
  // Real trusted input into the guest page — WhatsApp's React ignores synthetic DOM .click(),
  // so the chat-scan sweep drives it with these instead (WAC-004-live sweep).
  sendInputEvent(e: { type: string; x?: number; y?: number; button?: string; clickCount?: number; keyCode?: string; modifiers?: string[] }): void
  addEventListener(type: string, listener: (e: WaWebviewEvent) => void): void
  removeEventListener(type: string, listener: (e: WaWebviewEvent) => void): void
  reload(): void
}
// console-message carries `message`; did-start-navigation carries isMainFrame/isInPlace.
type WaWebviewEvent = { message?: string; isMainFrame?: boolean; isInPlace?: boolean }

// The extraction recipe (WAC-004/019) is no longer hardcoded here — it lives in main as DATA
// (src/main/whatsapp/recipe.ts), is fetched via wa:getRecipe, and injected into the sandboxed
// webview below. This is the safety boundary for the AI self-heal: a regenerated recipe is a new
// data string executed ONLY in the guest page, never source. The pane monitors extraction health
// (__WA_HEALTH__) and, if the recipe stops capturing, sends a structure-only diagnostic
// (__WA_DIAG__) to wa:heal for an AI rewrite, then rolls back if the rewrite also fails.

// The WhatsApp surface (WAC-012): Conversations on the left, the selected chat on the right.
// A THIRD observation source feeding the SAME shared Suggestion inbox (above) as email + meetings
// — extracted obligations appear there, tagged `whatsapp`, opening their source messages. This
// view is the connector's trust instrument (like the meeting transcript review): you watch which
// messages produced which obligations, and you draft replies here — but a reply is NEVER sent
// automatically (WAC-013, Level 2). Per-chat exclusions (WAC-015) keep personal chats unanalysed.

const SESSION_LABEL: Record<WaSessionState, string> = {
  mock: 'Demo mode — sample data',
  unauthenticated: 'Not linked',
  qr: 'Scan the QR with your phone to link this device',
  linked: 'Linked'
}

export function WhatsAppView(): React.JSX.Element {
  const [chats, setChats] = useState<WaConversationView[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [session, setSession] = useState<WaSessionState>('unauthenticated')
  const [wvConfig, setWvConfig] = useState<WaWebviewConfig | null>(null)
  const [include, setInclude] = useState<string[]>([])
  const [scopeOpen, setScopeOpen] = useState(false)
  const [scopeText, setScopeText] = useState('')
  const [tab, setTab] = useState<'chats' | 'topics'>('chats')

  const refresh = (): void => {
    void invoke('wa:listChats').then(setChats)
  }

  useEffect(() => {
    refresh()
    const applySession = (state: WaSessionState): void => {
      setSession(state)
      if (state === 'linked') Analytics.WhatsApp.linked()
    }
    void invoke('wa:sessionState').then((s) => applySession(s.state))
    void invoke('wa:webviewConfig').then(setWvConfig)
    void invoke('wa:getInclude').then((r) => setInclude(r.titles))
    const offMsgs = on('whatsapp:messagesChanged', refresh)
    const offSession = on('whatsapp:sessionState', (s) => applySession(s.state))
    return () => {
      offMsgs()
      offSession()
    }
  }, [])

  const saveScope = async (): Promise<void> => {
    const titles = scopeText
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
    const r = await invoke('wa:setInclude', titles)
    setInclude(r.titles)
    setScopeOpen(false)
    setSelected(null)
    refresh()
  }
  const openScope = (): void => {
    setScopeText(include.join('\n'))
    setScopeOpen((v) => !v)
  }

  const clearAll = async (): Promise<void> => {
    if (!window.confirm('Delete ALL indexed WhatsApp data (chats, messages, and derived action items)? This cannot be undone.')) return
    await invoke('wa:clearAll')
    setSelected(null)
    refresh()
  }

  const toggleDemo = async (enabled: boolean): Promise<void> => {
    const cfg = await invoke('wa:setDemo', enabled)
    setWvConfig(cfg)
    setSelected(null)
    refresh()
    void invoke('wa:sessionState').then((s) => setSession(s.state))
  }

  const demo = !!wvConfig?.demo
  const live = !!wvConfig?.enabled

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* banner: session state + demo toggle + delete */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-4 py-2 text-xs">
        <span className={`inline-flex items-center gap-1.5 ${session === 'linked' ? 'text-emerald-400' : demo ? 'text-muted-foreground' : 'text-amber-400'}`}>
          <span className={`size-2 rounded-full ${session === 'linked' ? 'bg-emerald-500' : demo ? 'bg-muted-foreground' : 'bg-amber-500'}`} />
          {demo ? SESSION_LABEL.mock : SESSION_LABEL[session]}
        </span>
        <div className="flex items-center gap-1 rounded-md bg-muted p-0.5">
          <Button size="xs" variant={tab === 'chats' ? 'secondary' : 'ghost'} onClick={() => setTab('chats')}>
            Chats
          </Button>
          <Button size="xs" variant={tab === 'topics' ? 'secondary' : 'ghost'} onClick={() => setTab('topics')}>
            Topics
          </Button>
        </div>
        <span className="flex-1" />
        <Button size="sm" variant={include.length ? 'secondary' : 'ghost'} onClick={openScope} title="Analyse ONLY these chats (allow-list). Empty = all chats.">
          {include.length ? `Analysing ${include.length} chat${include.length === 1 ? '' : 's'}` : 'Scope: all chats'}
        </Button>
        <label className="flex items-center gap-1.5 text-muted-foreground" title="Show sample data instead of a linked phone">
          <Switch checked={demo} onCheckedChange={(v) => void toggleDemo(v)} />
          Demo mode
        </label>
        <Button size="sm" variant="destructive" onClick={() => void clearAll()}>
          Delete WhatsApp data
        </Button>
      </div>

      {/* Inclusion allow-list editor: analyse ONLY the listed chats (by exact title, one per line). */}
      {scopeOpen && (
        <div className="shrink-0 border-b border-border bg-card px-4 py-3">
          <div className="mb-1 text-xs font-medium text-foreground">Analyse only these chats</div>
          <div className="mb-2 text-[11px] text-muted-foreground">
            One chat name per line (exactly as it appears in WhatsApp). Leave empty to analyse all chats.
            Chats removed from this list are purged from the assistant.
          </div>
          <Textarea
            value={scopeText}
            onChange={(e) => setScopeText(e.target.value)}
            rows={5}
            placeholder={'Jebakumar Ignite\nJoshua Church\nSelf\nWife'}
            className="text-sm"
          />
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="success" onClick={() => void saveScope()}>
              Save scope
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setScopeOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* The live webview stays MOUNTED + RENDERED whenever linked — even on the Topics tab — so
          background capture keeps running AND Topics can drive the composer (assign-in-WhatsApp).
          Off the Chats tab it's parked off-screen (kept laid-out, not display:none, which would stop
          the guest rendering and break sendInputEvent coordinates). */}
      {live && (
        <div className={tab === 'chats' ? 'flex min-h-0 flex-1 flex-col' : 'pointer-events-none absolute inset-0 -translate-x-[200%] opacity-0'}>
          <LiveWhatsAppPane cfg={wvConfig!} />
        </div>
      )}
      {tab === 'topics' ? (
        // Topics: conversation matters as digest cards (title + action items + message bits).
        <TopicsView />
      ) : !live ? (
        // Demo: our own chat list + conversation panes over the seeded sample data.
        <div className="flex min-h-0 flex-1">
          <div className="w-[300px] shrink-0 overflow-auto border-r border-border p-2">
            <div className="mb-1 px-1 text-xs uppercase tracking-wide text-muted-foreground">Conversations · {chats.length}</div>
            {chats.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">No chats yet.</p>
            ) : (
              <div className="space-y-1">
                {chats.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelected(c.id)}
                    className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${
                      selected === c.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted'
                    } ${c.excluded ? 'opacity-50' : ''}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{c.title}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {c.message_count} msg{c.message_count === 1 ? '' : 's'}
                        {c.excluded ? ' · excluded' : ''}
                      </span>
                    </span>
                    {c.is_group && <span className="ml-2 shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">group</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1 overflow-hidden">
            {selected ? (
              <Conversation key={selected} id={selected} onExcludedChange={refresh} />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                Select a conversation. Extracted obligations appear in the Suggestions inbox above, tagged{' '}
                <span className="mx-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">whatsapp</span>.
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ── Live embedded WhatsApp Web (WAC-002/004-live) ────────────────────────────────────────
// Renders the real WhatsApp Web in an Electron <webview> on the persistent partition — the QR
// appears here to link a phone, and stays linked across restarts. On dom-ready we inject the
// read-only DOM detector; its captured messages arrive as console messages, which we validate
// in main via wa:ingest. Nothing here ever sends a message.
// The sweep walks the chat list (scrolling as each screen is used up) and clicks rows to open them,
// letting the detector read each one (see sweep.ts). Capped +
// opt-in because opening a chat marks it read and sends a read receipt (a real side effect).
const SWEEP_MAX = 12
const SWEEP_DELAY_MS = 1700

function LiveWhatsAppPane({ cfg }: { cfg: WaWebviewConfig }): React.JSX.Element {
  const ref = useRef<HTMLElement>(null)
  // The guest-script runner for this webview (created on mount; shared with the sweep).
  const guest = useRef<Guest | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [sweep, setSweep] = useState<{ running: boolean; done: number; total: number; current?: string }>({ running: false, done: 0, total: 0 })
  const [heal, setHeal] = useState<'ok' | 'healing' | 'healed' | 'failed'>('ok')
  // Self-heal state machine (refs so the stable console-message handler can read/write them).
  const phase = useRef<'idle' | 'awaitDiag' | 'healing' | 'healed' | 'done'>('idle')
  const brokenTicks = useRef(0)
  // Healable ACTION selectors (open/compose/@mention/send/media). Seeded with defaults, overwritten
  // from wa:getSelectors on mount, and refreshed in place whenever an action heals a broken selector.
  const sels = useRef<Record<string, string>>({
    chatRow: '#pane-side [role="row"]',
    chatRowTitle: 'span[title]',
    header: '#main header',
    composer: '#main footer div[contenteditable="true"], #main footer [role="textbox"]',
    sendButton: '#main footer [data-icon="send"], #main footer button[aria-label*="Send" i], #main footer span[data-icon="send"]',
    mentionOption: '#main [role="listbox"] [role="option"], #main [role="option"]',
    voicePlay: 'button[aria-label*="Play voice" i], [data-icon="ptt-status"]',
    imageBlob: 'img[src^="blob:"]'
  })

  useEffect(() => {
    const wv = ref.current as unknown as WaWebview | null
    if (!wv) return
    const g = createGuest(wv)
    guest.current = g

    // Inject a recipe (data) into the sandboxed guest page. Clears the guard so a re-inject runs;
    // enables the WAC-019 internal-store read (all chats, no read receipts). false = it didn't run
    // (page not ready, or the recipe threw — the guest's error is logged by the runner).
    const inject = async (recipe: string): Promise<boolean> => {
      if (!(await g.run('armRecipe', gs.armRecipe)).ok) return false
      return (await g.runData('recipe', recipe)).ok
    }

    const onDom = async (): Promise<void> => {
      g.setReady(true)
      setLoaded(true)
      try {
        const { recipe } = await invoke('wa:getRecipe')
        await inject(recipe)
      } catch (e) {
        console.warn('[wa-guest] recipe fetch failed:', e)
      }
    }
    // A main-frame navigation (reload, WhatsApp's own redirects) tears down the page: stop calling
    // into it until the next dom-ready rather than racing a half-loaded document.
    const onNavStart = (e: WaWebviewEvent): void => {
      if (e.isMainFrame && !e.isInPlace) g.setReady(false)
    }

    // Load the healable action selectors (may already carry earlier heals).
    void invoke('wa:getSelectors')
      .then((r) => {
        if (r.selectors) sels.current = { ...sels.current, ...r.selectors }
      })
      .catch(() => undefined)

    // ── Action self-heal (WAC-019 for the write/media path) ──────────────────────────────
    // When an action can't find its target (WhatsApp changed the DOM), grab a STRUCTURE-ONLY
    // snapshot (tags/roles/data-icon/aria — never message text) and let the AI rewrite the failing
    // selector(s). The rewritten selectors are applied in place, so the immediate retry + all future
    // actions use them. resolve() is querySelector-safe against a bad heal.
    const actionDiag = async (): Promise<string> => {
      const r = await g.run('actionDiagnostic', gs.actionDiagnostic)
      return r.ok ? r.value : '{}'
    }
    const healActions = async (keys: string[]): Promise<string[]> => {
      try {
        const r = await invoke('wa:healSelectors', keys, await actionDiag())
        if (r.selectors) sels.current = { ...sels.current, ...r.selectors }
        return r.healed ?? []
      } catch {
        return []
      }
    }

    // WAC-021: trigger WhatsApp's own "Download" on a media item WITHOUT playing/opening it.
    // Synthetic DOM events can't open WhatsApp's message menu (it requires trusted input), so this
    // drives real mouse events via sendInputEvent: right-click the media → click the "Download"
    // item. The main-process will-download interceptor (already armed via wa:expectMediaDownload)
    // captures the decrypted file. Voice → right of the Play button (right-clicking the button
    // itself is swallowed); image → the blob-image centre.
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const rightClickAt = (x: number, y: number): void => {
      wv.sendInputEvent({ type: 'mouseMove', x, y })
      wv.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 })
      wv.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 })
    }
    const leftClickAt = (x: number, y: number): void => {
      wv.sendInputEvent({ type: 'mouseMove', x, y })
      wv.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      wv.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    }
    const triggerMediaDownload = async (messageId: string): Promise<void> => {
      const rowSel = `#main div[data-id="${messageId.replace(/"/g, '\\"')}"]`
      const findVoicePoint = async (): Promise<gs.Point | null> => {
        const r = await g.run('voiceMenuPoint', gs.voiceMenuPoint, rowSel, sels.current.voicePlay)
        return r.ok ? r.value : null
      }
      let pt = await findVoicePoint()
      if (!pt) {
        await healActions(['voicePlay'])
        pt = await findVoicePoint()
      }
      if (!pt) return
      rightClickAt(pt.x, pt.y)
      await sleep(650)
      const item = await g.run('downloadMenuItemPoint', gs.downloadMenuItemPoint)
      if (item.ok && item.value) leftClickAt(item.value.x, item.value.y)
    }

    // WAC-021 image capture: images expose a full-res blob in the DOM, so just fetch the bytes in
    // the guest page (executeJavaScript resolves the promise + returns the base64 — no console-size
    // limit, no download dance) and hand them to main for a vision description.
    const captureImage = async (messageId: string, ctx: Record<string, unknown>): Promise<void> => {
      const rowSel = `#main div[data-id="${messageId.replace(/"/g, '\\"')}"]`
      const fetchBlob = async (): Promise<{ b64: string; mime: string } | null> => {
        const r = await g.run('imageBlob', gs.imageBlob, rowSel, sels.current.imageBlob)
        return r.ok ? r.value : null
      }
      let img = await fetchBlob()
      if (!img) {
        await healActions(['imageBlob'])
        img = await fetchBlob()
      }
      if (!img || !img.b64) return
      void invoke('wa:describeImage', { ...ctx, messageId, image: img.b64, mime: img.mime } as never)
    }

    // Health: the page has messages but we captured none ⇒ the recipe broke ⇒ trigger AI-heal.
    const onHealth = (h: { linked?: boolean; domMsgs?: number; captured?: number }): void => {
      const broken = !!h.linked && (h.domMsgs ?? 0) > 0 && (h.captured ?? 0) === 0
      if (!broken) {
        brokenTicks.current = 0
        return
      }
      brokenTicks.current++
      if (brokenTicks.current < 2) return
      if (phase.current === 'idle') {
        phase.current = 'awaitDiag'
        setHeal('healing')
        void g.run('requestRecipeDiag', gs.requestRecipeDiag)
      } else if (phase.current === 'healed') {
        // The AI-rewritten recipe is ALSO broken → roll back to last-known-good, once, then stop.
        phase.current = 'done'
        setHeal('failed')
        void invoke('wa:rollbackRecipe').then((r) => inject(r.recipe))
      }
    }

    // A structure-only diagnostic arrived → ask main to AI-rewrite the recipe, then re-inject it.
    const onDiag = async (diag: string): Promise<void> => {
      if (phase.current !== 'awaitDiag') return
      phase.current = 'healing'
      const res = await invoke('wa:heal', diag)
      if (res.ok && res.recipe && (await inject(res.recipe))) {
        brokenTicks.current = 0
        phase.current = 'healed'
        setHeal('healed')
      } else if (res.ok && res.recipe) {
        // The rewrite threw on injection (its error is logged) → back to last-known-good now.
        phase.current = 'done'
        setHeal('failed')
        void invoke('wa:rollbackRecipe').then((r) => inject(r.recipe))
      } else {
        phase.current = 'done'
        setHeal('failed') // no API key / model declined — keeps the current recipe
      }
    }

    const onConsole = (e: WaWebviewEvent): void => {
      const m = e.message ?? ''
      if (m.startsWith('__WA_MSG__')) {
        try {
          void invoke('wa:ingest', JSON.parse(m.slice(10)) as NormalizedMessage)
        } catch {
          /* malformed */
        }
      } else if (m.startsWith('__WA_STATE__')) {
        void invoke('wa:reportSession', m.slice(12) as WaSessionState)
      } else if (m.startsWith('__WA_AUDIO__')) {
        // WAC-021 media (voice or image). Preferred path (need:'download'): arm the context, then
        // trigger WhatsApp's own Download — Electron intercepts the decrypted file (no playing/
        // opening). Fallback (payload carries audio bytes): transcribe directly via Sarvam in main.
        try {
          const p = JSON.parse(m.slice(12)) as {
            need?: string
            mediaKind?: 'voice' | 'image'
            messageId: string
            conversationId: string
            conversationTitle: string
            from: string
            direction: 'incoming' | 'outgoing'
            timestamp: number
            isGroup?: boolean
          }
          const ctx = {
            conversationId: p.conversationId,
            conversationTitle: p.conversationTitle,
            from: p.from,
            direction: p.direction,
            timestamp: p.timestamp,
            isGroup: p.isGroup
          }
          if (p.need === 'image') {
            void captureImage(p.messageId, ctx)
          } else if (p.need === 'download') {
            void invoke('wa:expectMediaDownload', { ...ctx, messageId: p.messageId, mediaKind: 'voice' }).then(() =>
              triggerMediaDownload(p.messageId)
            )
          } else {
            void invoke('wa:transcribeAudio', p as never)
          }
        } catch {
          /* malformed */
        }
      } else if (m.startsWith('__WA_HEALTH__')) {
        try {
          onHealth(JSON.parse(m.slice(13)) as { linked?: boolean; domMsgs?: number; captured?: number })
        } catch {
          /* */
        }
      } else if (m.startsWith('__WA_DIAG__')) {
        void onDiag(m.slice(11))
      }
    }

    // ── Assign-in-WhatsApp: post a task back into the source group, @mentioning a participant ──
    // OUTBOUND. Only ever called after the Topics UI showed a preview and the user confirmed. Drives
    // the real composer with trusted key events so WhatsApp's @mention autocomplete fires (a real
    // mention notifies the person — plain "@name" text does not). Aborts before sending if anything
    // is off (group won't open, no composer, mention didn't resolve) so we never send a wrong message.
    const key = (keyCode: string): void => {
      wv.sendInputEvent({ type: 'keyDown', keyCode })
      wv.sendInputEvent({ type: 'char', keyCode })
      wv.sendInputEvent({ type: 'keyUp', keyCode })
    }
    const typeStr = async (s: string): Promise<void> => {
      for (const ch of s) {
        key(ch)
        await new Promise((r) => setTimeout(r, 28))
      }
    }
    const headerFirstLine = async (): Promise<string> => {
      const r = await g.run('headerTitle', gs.headerTitle, sels.current.header)
      return r.ok ? r.value : ''
    }
    const findRowPoint = async (title: string): Promise<gs.Point | null> => {
      const r = await g.run('chatRowPoint', gs.chatRowPoint, sels.current.chatRow, sels.current.chatRowTitle, title)
      return r.ok ? r.value : null
    }
    const openGroupByTitle = async (title: string): Promise<boolean> => {
      if ((await headerFirstLine()) === title) return true
      let p = await findRowPoint(title)
      if (!p) {
        // chat-list selectors changed → AI-heal them, then retry finding the row
        await healActions(['chatRow', 'chatRowTitle'])
        p = await findRowPoint(title)
      }
      if (!p) return false
      leftClickAt(p.x, p.y)
      await new Promise((r) => setTimeout(r, 1200))
      return (await headerFirstLine()) === title
    }
    const sendTaskImpl = async (payload: WaTaskSend): Promise<{ ok: boolean; error?: string }> => {
      try {
        if (!(await openGroupByTitle(payload.conversationTitle))) return { ok: false, error: `Couldn't open "${payload.conversationTitle}"` }
        // WhatsApp's composer is a Lexical editor we can't reliably clear, so we NEVER clobber it: if
        // it holds a draft, abort (don't destroy the user's text). Insert via execCommand insertText
        // (emoji-safe). If the composer selector is stale, AI-heal it and retry once.
        const tryInsert = async (): Promise<string> => {
          const r = await g.run('insertIntoComposer', gs.insertIntoComposer, sels.current.composer, payload.text)
          return r.ok ? r.value : 'err'
        }
        let focused = await tryInsert()
        if (focused === 'no-composer') {
          await healActions(['composer'])
          focused = await tryInsert()
        }
        if (focused === 'no-composer' || focused === 'err') return { ok: false, error: 'Message box not found' }
        if (focused === 'not-empty') return { ok: false, error: 'The message box already has a draft — clear it first, then Send.' }
        // Append a real @mention. Type ' @<firstname>' with trusted CHAR keys so WhatsApp's mention
        // autocomplete fires, then CLICK the matching option (Enter-to-select proved unreliable; a
        // trusted click is solid). If the option selector is stale, AI-heal + retry; abort before
        // sending if it still never appears — we won't post a dead "@name" that notifies nobody.
        if (payload.assignee) {
          const first = payload.assignee.split(/\s+/)[0]
          const caret = await g.run('caretToComposerEnd', gs.caretToComposerEnd, sels.current.composer)
          if (!caret.ok || !caret.value) return { ok: false, error: 'Message box not found' }
          await typeStr(' @' + first.slice(0, 6))
          await new Promise((r) => setTimeout(r, 650))
          const findOpt = async (): Promise<gs.Point | null> => {
            const r = await g.run('mentionOptionPoint', gs.mentionOptionPoint, sels.current.mentionOption, first.replace(/[^a-z0-9]/gi, ''))
            return r.ok ? r.value : null
          }
          let opt = await findOpt()
          if (!opt) {
            await healActions(['mentionOption'])
            opt = await findOpt()
          }
          if (!opt) return { ok: false, error: `Couldn't @mention "${payload.assignee}" — no autocomplete match. Nothing sent.` }
          leftClickAt(opt.x, opt.y) // select the mention (trusted click, not Enter)
          await new Promise((r) => setTimeout(r, 400))
        }
        // Send by CLICKING the send button (appears once the composer has text) — not Enter. The
        // guest returns 'empty' if the composer is empty (never fire a blank send), null if the
        // button selector is stale (→ AI-heal + retry), else the button point. A failed guest call
        // counts as 'empty' so it's never mistaken for a stale selector.
        const findBtn = async (): Promise<gs.Point | 'empty' | null> => {
          const r = await g.run('sendButtonPoint', gs.sendButtonPoint, sels.current.composer, sels.current.sendButton)
          return r.ok ? r.value : 'empty'
        }
        let btn = await findBtn()
        if (btn === null) {
          await healActions(['sendButton'])
          btn = await findBtn()
        }
        if (btn === 'empty' || btn === null) return { ok: false, error: 'Send button not found (nothing sent)' }
        leftClickAt(btn.x, btn.y) // send
        await new Promise((r) => setTimeout(r, 600))
        const remaining = await g.run('composerText', gs.composerText, sels.current.composer)
        return remaining.ok && remaining.value === '' ? { ok: true } : { ok: false, error: 'Send may not have completed' }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'send failed' }
      }
    }
    registerWaSender(sendTaskImpl)

    const domHandler = (): void => void onDom()
    wv.addEventListener('dom-ready', domHandler)
    wv.addEventListener('did-start-navigation', onNavStart)
    wv.addEventListener('console-message', onConsole)
    return () => {
      registerWaSender(null)
      g.setReady(false)
      guest.current = null
      wv.removeEventListener('dom-ready', domHandler)
      wv.removeEventListener('did-start-navigation', onNavStart)
      wv.removeEventListener('console-message', onConsole)
    }
  }, [])

  const runSweep = async (): Promise<void> => {
    const wv = ref.current as unknown as WaWebview | null
    const g = guest.current
    if (!wv || !g || sweep.running) return
    if (
      !window.confirm(
        'Read your chats?\n\nOpens chats so the assistant can read them — UNREAD chats first, ' +
          'skipping chats already read + captured and any you excluded. ' +
          'Opening a chat marks it READ and sends a read receipt to the sender. ' +
          `Up to ${SWEEP_MAX} chats will be opened.`
      )
    )
      return

    // What we already have + what to avoid, so the sweep is incremental (don't re-open chats we've
    // captured with nothing new) and honours per-chat exclusions (WAC-015).
    const known = await invoke('wa:listChats').catch(() => [])
    const inc = await invoke('wa:getInclude').catch(() => ({ titles: [] as string[] }))
    const slugify = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat'
    const includeSlugs = new Set(inc.titles.map(slugify)) // when non-empty, open ONLY these chats
    const excluded = new Set(known.filter((c) => c.excluded).map((c) => c.id))
    const captured = new Set(known.map((c) => c.id)) // chats already in our store

    // Guest reads use the healable selectors (an action heal of chatRow/header fixes the sweep too).
    // Rows are re-read every step (fresh coords + unread state — the list re-renders as chats open
    // and as it scrolls). Coords are guest-viewport px = webview px.
    const visibleRows = async (): Promise<gs.ChatRow[]> => {
      const r = await g.run('visibleChatRows', gs.visibleChatRows, sels.current.chatRow, sels.current.chatRowTitle)
      return r.ok ? r.value : []
    }
    // Real click: move → down → up. WhatsApp ignores synthetic clicks; sendInputEvent is trusted.
    const clickAt = (x: number, y: number): void => {
      wv.sendInputEvent({ type: 'mouseMove', x, y })
      wv.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      wv.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    }
    // Human-like jitter so the pacing doesn't look like rapid-fire automation (lower ban signal).
    const jitter = (base: number): number => base + Math.floor(Math.random() * 500)
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    setSweep({ running: true, done: 0, total: SWEEP_MAX })
    const { opened } = await sweepChats({
      maxOpens: SWEEP_MAX,
      visibleRows,
      scroll: async () => {
        const r = await g.run('scrollChatList', gs.scrollChatList, sels.current.chatRow)
        return r.ok && r.value.moved
      },
      settle: () => sleep(jitter(400)),
      open: async (row) => {
        clickAt(row.x, row.y)
        await sleep(jitter(SWEEP_DELAY_MS)) // let it open + the detector read it
      },
      header: async () => {
        const r = await g.run('headerTitle', gs.headerTitle, sels.current.header)
        return r.ok ? r.value : ''
      },
      // Skip (never open): out-of-scope (allow-list), excluded, and read+captured.
      skip: (row) => {
        const s = slugify(row.title)
        const outOfScope = includeSlugs.size > 0 && !includeSlugs.has(s)
        return outOfScope || excluded.has(s) || (!row.unread && captured.has(s))
      },
      onOpening: (row, done) => setSweep({ running: true, done, total: SWEEP_MAX, current: (row.unread ? '🔵 ' : '') + row.title })
    })
    setSweep({ running: false, done: opened, total: opened })
    Analytics.WhatsApp.scanned({ count: opened })
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-3 py-1.5 text-xs">
        <span className="text-muted-foreground">Embedded WhatsApp Web</span>
        {heal === 'healing' && <span className="text-amber-300">⟳ Self-healing reader…</span>}
        {heal === 'healed' && <span className="text-emerald-400">✓ Reader auto-updated</span>}
        {heal === 'failed' && <span className="text-red-400" title="Reading broke and could not be auto-fixed (needs an API key or a manual recipe update)">⚠ Reader needs attention</span>}
        <span className="flex-1" />
        {sweep.running ? (
          <span className="text-amber-300">
            Reading {sweep.done + 1}/{sweep.total}: {sweep.current ?? '…'}
          </span>
        ) : (
          <>
            {sweep.total > 0 && <span className="text-emerald-400">Read {sweep.total} chats</span>}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runSweep()}
              title="Opens each visible chat so the assistant can read it — marks them read + sends read receipts"
            >
              ⤵ Read my chats
            </Button>
          </>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {!loaded && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background text-sm text-muted-foreground">
            Loading WhatsApp Web… scan the QR with your phone to link this device.
          </div>
        )}
        <webview
          ref={ref}
          src={cfg.url}
          partition={cfg.partition}
          useragent={cfg.userAgent}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  )
}

// ── One conversation: messages + exclude toggle + gated draft reply (Level 2) ────────────
function Conversation({ id, onExcludedChange }: { id: string; onExcludedChange: () => void }): React.JSX.Element {
  const [conversation, setConversation] = useState<WaConversationView | null>(null)
  const [messages, setMessages] = useState<WaMessageView[]>([])
  const [draft, setDraft] = useState<string | null>(null)
  const [drafting, setDrafting] = useState(false)

  const load = (): void => {
    void invoke('wa:getConversation', id).then((r) => {
      setConversation(r?.conversation ?? null)
      setMessages(r?.messages ?? [])
    })
  }

  useEffect(() => {
    load()
    return on('whatsapp:messagesChanged', load)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const toggleExcluded = async (): Promise<void> => {
    if (!conversation) return
    await invoke('wa:setExcluded', id, !conversation.excluded)
    load()
    onExcludedChange()
  }

  const doDraft = async (): Promise<void> => {
    setDrafting(true)
    setDraft(null)
    try {
      const r = await invoke('wa:draftReply', id)
      setDraft(r.ok ? (r.draft ?? '') : `Couldn’t draft: ${r.error ?? 'unknown error'}`)
      if (r.ok) Analytics.WhatsApp.draftReply({ conversation_id: id })
    } finally {
      setDrafting(false)
    }
  }

  if (!conversation) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{conversation.title}</div>
          <div className="text-xs text-muted-foreground">
            {conversation.is_group ? 'Group · ' : ''}
            {conversation.participants.join(', ') || '—'}
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Exclude this chat from analysis (WAC-015)">
          <Switch checked={conversation.excluded} onCheckedChange={() => void toggleExcluded()} />
          Exclude from analysis
        </label>
      </div>

      {/* messages */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {conversation.excluded && (
          <p className="mb-3 rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
            This chat is excluded — its messages are never analysed or sent to the cloud.
          </p>
        )}
        <div className="flex flex-col gap-2">
          {messages.map((m) => (
            <div
              key={m.message_id}
              className={`max-w-[75%] rounded-lg px-3 py-1.5 text-sm ${
                m.direction === 'outgoing' ? 'self-end bg-emerald-800/50 text-emerald-50' : 'self-start bg-muted text-foreground'
              }`}
            >
              {m.direction === 'incoming' && m.sender && <div className="text-[11px] font-semibold text-muted-foreground">{m.sender}</div>}
              <div className="whitespace-pre-wrap">{m.text}</div>
              <div className="mt-0.5 text-right text-[10px] text-muted-foreground">{new Date(m.timestamp).toLocaleTimeString()}</div>
            </div>
          ))}
          {messages.length === 0 && <p className="text-sm text-muted-foreground">No messages.</p>}
        </div>
      </div>

      {/* gated draft reply — Level 2: drafts only, never sends */}
      {!conversation.excluded && (
        <div className="shrink-0 border-t border-border p-3">
          {draft === null ? (
            <Button size="sm" variant="secondary" onClick={() => void doDraft()} disabled={drafting}>
              {drafting ? 'Drafting…' : '✎ Draft a reply'}
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} className="resize-y" />
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">
                  Draft only — nothing is sent. Copy it into WhatsApp yourself, or send from the linked session (never automatic).
                </span>
                <span className="flex-1" />
                <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(draft)}>
                  Copy
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>
                  Discard
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
