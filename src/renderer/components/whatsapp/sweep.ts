// The chat-scan sweep's decision loop (WAC-004-live), kept free of the webview so it can be tested:
// the pane supplies the guest reads/clicks as deps. It walks WhatsApp's chat list top to bottom —
// scrolling as each screen is used up — opening chats (unread first, then never-captured ones)
// until it has opened `maxOpens`, or reached the true end of the list.

import type { ChatRow } from './guest-scripts'

export interface SweepDeps {
  /** Rows currently on screen, with fresh click coords + unread state. */
  visibleRows(): Promise<ChatRow[]>
  /** Scroll the list one step; false = it didn't move (end of list, or no list). */
  scroll(): Promise<boolean>
  /** Click the row and give the chat time to open + the recipe time to read it. */
  open(row: ChatRow): Promise<void>
  /** Title of the currently-open chat ('' = none / unreadable). */
  header(): Promise<string>
  /** Rows never to open: out of scope, excluded, or already read + captured. */
  skip(row: ChatRow): boolean
  /** Pause after a scroll so the virtualised list renders the newly-revealed rows. */
  settle(): Promise<void>
  maxOpens: number
  /** True once the user asked the sweep to stop (checked before each step). */
  stopped?(): boolean
  /** Progress: how many chats this sweep has found to read so far (grows as the list scrolls). */
  onFound?(count: number): void
  onOpening?(row: ChatRow, opened: number): void
  /** Progress: a chat opened and was read. */
  onRead?(row: ChatRow, opened: number): void
}

// Clicks in a row that don't open a new chat before we give up (something is off with the page).
const MAX_MISSES = 5
// A scroll that doesn't move is re-tried once after a pause (WhatsApp may still be loading more
// chats at the bottom) before it counts as the end of the list.
const END_CONFIRMATIONS = 2
// Hard stop so a list that never settles can't spin forever.
const MAX_STEPS = 500

export async function sweepChats(d: SweepDeps): Promise<{ opened: number; reachedEnd: boolean }> {
  const decided = new Set<string>() // titles we've opened OR deliberately skipped
  const found = new Set<string>() // titles this sweep means to read (not skipped)
  let opened = 0
  let misses = 0
  let stuck = 0
  let prevHeader = await d.header()
  for (let step = 0; step < MAX_STEPS && opened < d.maxOpens && misses < MAX_MISSES && !d.stopped?.(); step++) {
    const rows = (await d.visibleRows()).filter((r) => r.title && !decided.has(r.title))
    for (const r of rows) if (d.skip(r)) decided.add(r.title)
    const before = found.size
    for (const r of rows) if (!decided.has(r.title)) found.add(r.title)
    if (found.size !== before) d.onFound?.(found.size)
    // Priority: unread first (new content / obligations), then never-captured chats (backfill).
    const next = rows.filter((r) => !decided.has(r.title)).sort((a, b) => (b.unread ? 1 : 0) - (a.unread ? 1 : 0))[0]
    if (!next) {
      // This screen is used up — move on down the list.
      if (await d.scroll()) stuck = 0
      else if (++stuck >= END_CONFIRMATIONS) return { opened, reachedEnd: true }
      await d.settle()
      continue
    }
    decided.add(next.title)
    d.onOpening?.(next, opened)
    await d.open(next)
    const hdr = await d.header()
    if (hdr && hdr !== prevHeader) {
      opened++
      prevHeader = hdr
      misses = 0
      d.onRead?.(next, opened)
    } else {
      misses++ // click didn't open a new chat — try the next candidate
    }
  }
  return { opened, reachedEnd: false }
}
