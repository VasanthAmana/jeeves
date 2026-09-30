import type { WaSweepEvent, WaSweepProgress } from '../../shared/ipc-contract'

// Live progress of a chat sweep ("Read my chats"). The renderer drives the sweep — it owns the
// <webview> — and reports each step (start / chats found / opening / read / end); ingest reports
// every message it stores. This tracker turns both into one WaSweepProgress snapshot that main
// pushes to the UI, so the counts come from what was actually captured, not from the page.
// Pure (no Electron): the owner passes `publish`, which observer.ts wires to a broadcast.

const MESSAGE_PUBLISH_MS = 200 // coalesce message bursts (a chat can deliver dozens at once)
const WATCHDOG_MS = 90_000 // no step for this long while running ⇒ the pane went away mid-sweep

export function idleProgress(): WaSweepProgress {
  return {
    state: 'idle',
    chatsRead: 0,
    chatsTotal: null,
    chatsFound: 0,
    messagesSeen: 0,
    messagesNew: 0,
    current: null,
    currentMessages: 0,
    startedAt: null,
    endedAt: null,
    note: null
  }
}

export class SweepTracker {
  private p: WaSweepProgress = idleProgress()
  private limit = 0
  private currentId: string | null = null
  private publishTimer: ReturnType<typeof setTimeout> | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null

  private readonly publish: (p: WaSweepProgress) => void
  private readonly slug: (title: string) => string
  private readonly now: () => number

  constructor(publish: (p: WaSweepProgress) => void, slug: (title: string) => string, now: () => number = Date.now) {
    this.publish = publish
    this.slug = slug
    this.now = now
  }

  snapshot(): WaSweepProgress {
    return { ...this.p }
  }

  /** Apply one step reported by the renderer; returns the new snapshot (also published). */
  event(e: WaSweepEvent): WaSweepProgress {
    if (e.type === 'start') {
      this.limit = Math.max(0, Math.floor(e.limit) || 0)
      this.currentId = null
      this.p = { ...idleProgress(), state: 'running', startedAt: this.now() }
    } else if (this.p.state !== 'running') {
      return this.snapshot() // a late step from a sweep that already ended — ignore
    } else if (e.type === 'found') {
      this.p.chatsFound = Math.max(this.p.chatsFound, Math.floor(e.count) || 0)
      // The total is known once the page says so, or once enough chats were found to fill the cap.
      if (typeof e.total === 'number') this.p.chatsTotal = Math.max(0, Math.floor(e.total))
      else if (this.limit > 0 && this.p.chatsFound >= this.limit) this.p.chatsTotal = this.limit
    } else if (e.type === 'opening') {
      this.p.current = String(e.title).slice(0, 200)
      this.p.currentMessages = 0
      this.currentId = this.slug(this.p.current)
    } else if (e.type === 'read') {
      this.p.chatsRead++
      this.p.chatsFound = Math.max(this.p.chatsFound, this.p.chatsRead)
    } else if (e.type === 'end') {
      this.p.state = e.stopped ? 'stopped' : 'finished'
      this.p.endedAt = this.now()
      this.p.chatsTotal = this.p.chatsRead // what this sweep ended up reading
      this.p.note = e.note ? String(e.note).slice(0, 300) : null
      this.p.current = null
      this.currentId = null
    }
    this.armWatchdog()
    this.flush()
    return this.snapshot()
  }

  /** Ingest stored (isNew) or re-saw a message. Counted only while a sweep runs. */
  message(msg: { conversationId: string; conversationTitle: string }, isNew: boolean): void {
    if (this.p.state !== 'running') return
    this.p.messagesSeen++
    if (isNew) this.p.messagesNew++
    if (this.currentId && (msg.conversationId === this.currentId || msg.conversationTitle === this.p.current)) this.p.currentMessages++
    if (!this.publishTimer) {
      this.publishTimer = setTimeout(() => this.flush(), MESSAGE_PUBLISH_MS)
      this.publishTimer.unref?.()
    }
  }

  /** Publish the current snapshot now (cancels a pending coalesced publish). */
  flush(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer)
    this.publishTimer = null
    this.publish(this.snapshot())
  }

  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    if (this.p.state !== 'running') return
    this.watchdog = setTimeout(() => {
      if (this.p.state === 'running') this.event({ type: 'end', stopped: true, note: 'Lost contact with the WhatsApp pane' })
    }, WATCHDOG_MS)
    this.watchdog.unref?.()
  }
}
