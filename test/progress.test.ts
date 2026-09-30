// Sweep progress (src/main/whatsapp/progress.ts): the counts the UI shows while "Read my chats" runs
// — chats read of the total (or found so far), messages captured, the chat being read — and the
// final finished/stopped state.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SweepTracker } from '../src/main/whatsapp/progress.ts'
import { sweepChats } from '../src/renderer/components/whatsapp/sweep.ts'
import { slugifyTitle } from '../src/main/whatsapp/source.ts'
import type { WaSweepProgress } from '../src/shared/ipc-contract.ts'

function tracker(): { t: SweepTracker; published: WaSweepProgress[] } {
  const published: WaSweepProgress[] = []
  let clock = 1000
  const t = new SweepTracker((p) => published.push(p), slugifyTitle, () => clock++)
  return { t, published }
}

const msg = (title: string): { conversationId: string; conversationTitle: string } => ({ conversationId: slugifyTitle(title), conversationTitle: title })

test('counts chats and messages through a sweep, and ends finished with the final counts', () => {
  const { t, published } = tracker()
  t.message(msg('Alpha'), true) // before any sweep: not counted
  assert.equal(t.snapshot().state, 'idle')

  t.event({ type: 'start', limit: 12 })
  t.event({ type: 'found', count: 3 })
  let p = t.snapshot()
  assert.equal(p.state, 'running')
  assert.equal(p.chatsTotal, null) // 3 found, cap 12, list not exhausted: total unknown
  assert.equal(p.chatsFound, 3)

  t.event({ type: 'opening', title: 'Alpha Team' })
  t.message(msg('Alpha Team'), true)
  t.message(msg('Alpha Team'), true)
  t.message(msg('Alpha Team'), false) // already stored: seen, not new
  t.message(msg('Beta'), true) // another chat (the store read) — counts overall, not for the current chat
  t.flush()
  p = published.at(-1)!
  assert.equal(p.current, 'Alpha Team')
  assert.equal(p.currentMessages, 3)
  assert.equal(p.messagesSeen, 4)
  assert.equal(p.messagesNew, 3)

  t.event({ type: 'read', title: 'Alpha Team' })
  t.event({ type: 'opening', title: 'Gamma' })
  assert.equal(t.snapshot().currentMessages, 0) // per-chat count restarts
  t.event({ type: 'read', title: 'Gamma' })
  t.event({ type: 'end', stopped: false, note: 'No more chats to read' })

  p = published.at(-1)!
  assert.equal(p.state, 'finished')
  assert.equal(p.chatsRead, 2)
  assert.equal(p.chatsTotal, 2)
  assert.equal(p.messagesSeen, 4)
  assert.equal(p.current, null)
  assert.equal(p.note, 'No more chats to read')
  assert.ok(p.endedAt !== null && p.startedAt !== null && p.endedAt > p.startedAt)

  // After the end: late steps and messages don't change the result.
  t.event({ type: 'read', title: 'Late' })
  t.message(msg('Gamma'), true)
  assert.equal(t.snapshot().chatsRead, 2)
  assert.equal(t.snapshot().messagesSeen, 4)
})

test('the total is known once enough chats are found to fill the cap (or the page says so)', () => {
  const { t } = tracker()
  t.event({ type: 'start', limit: 5 })
  t.event({ type: 'found', count: 7 })
  assert.equal(t.snapshot().chatsTotal, 5)

  t.event({ type: 'start', limit: 12 })
  assert.equal(t.snapshot().chatsTotal, null) // a new sweep starts from zero
  t.event({ type: 'found', count: 2, total: 4 })
  assert.equal(t.snapshot().chatsTotal, 4)
})

test('a stopped sweep ends in the stopped state with what it read so far', () => {
  const { t, published } = tracker()
  t.event({ type: 'start', limit: 12 })
  t.event({ type: 'opening', title: 'Alpha' })
  t.message(msg('Alpha'), true)
  t.event({ type: 'read', title: 'Alpha' })
  t.event({ type: 'opening', title: 'Beta' })
  t.event({ type: 'end', stopped: true, note: 'Stopped before finishing' })
  const p = published.at(-1)!
  assert.equal(p.state, 'stopped')
  assert.equal(p.chatsRead, 1)
  assert.equal(p.messagesNew, 1)
  assert.equal(p.note, 'Stopped before finishing')
})

test('message bursts are coalesced into one publish; steps publish immediately', async () => {
  const { t, published } = tracker()
  t.event({ type: 'start', limit: 12 })
  const afterStart = published.length
  for (let i = 0; i < 50; i++) t.message(msg('Alpha'), true)
  assert.equal(published.length, afterStart) // nothing yet — coalescing
  await new Promise((r) => setTimeout(r, 260))
  assert.equal(published.length, afterStart + 1)
  assert.equal(published.at(-1)!.messagesSeen, 50)
})

/** The pane's wiring (whatsapp-view.tsx): sweepChats' hooks → wa:sweepEvent → the tracker; opening a
 *  chat makes the recipe deliver its messages → ingest → tracker.message. */
async function sweepThrough(chats: { title: string; unread: boolean; msgs: number }[], opts: { perScreen: number; stopAfter?: number }) {
  const { t, published } = tracker()
  let top = 0
  let header = ''
  let stop = false
  t.event({ type: 'start', limit: 12 })
  const r = await sweepChats({
    maxOpens: 12,
    visibleRows: async () => chats.slice(top, top + opts.perScreen).map((c, i) => ({ title: c.title, unread: c.unread, x: 100, y: 100 + i * 72 })),
    scroll: async () => {
      const next = Math.min(top + opts.perScreen, Math.max(0, chats.length - opts.perScreen))
      const moved = next > top
      top = next
      return moved
    },
    settle: async () => {},
    open: async (row) => {
      header = row.title
      const c = chats.find((x) => x.title === row.title)!
      for (let i = 0; i < c.msgs; i++) t.message(msg(c.title), i % 2 === 0)
    },
    header: async () => header,
    skip: (row) => !chats.find((x) => x.title === row.title)!.unread,
    stopped: () => stop,
    onFound: (count) => t.event({ type: 'found', count }),
    onOpening: (row) => t.event({ type: 'opening', title: row.title }),
    onRead: (row, opened) => {
      t.event({ type: 'read', title: row.title })
      if (opts.stopAfter && opened >= opts.stopAfter) stop = true // the user pressed Stop
    }
  })
  t.event({ type: 'end', stopped: stop })
  return { r, final: published.at(-1)!, published }
}

test('through the real sweep loop: chats found grow as the list scrolls, then final counts', async () => {
  const chats = Array.from({ length: 9 }, (_, i) => ({ title: `Chat ${i + 1}`, unread: i !== 4, msgs: i + 1 }))
  const { r, final, published } = await sweepThrough(chats, { perScreen: 3 })
  assert.equal(r.opened, 8) // Chat 5 is read + captured: skipped
  // While running, "found so far" grew screen by screen (3, then 5, then 8), never past what was on screen.
  const found = [...new Set(published.filter((p) => p.state === 'running' && p.chatsFound > 0).map((p) => p.chatsFound))]
  assert.deepEqual(found.slice(0, 3), [3, 5, 8])
  assert.equal(final.state, 'finished')
  assert.equal(final.chatsRead, 8)
  assert.equal(final.chatsTotal, 8)
  assert.equal(final.messagesSeen, 1 + 2 + 3 + 4 + 6 + 7 + 8 + 9)
})

test('through the real sweep loop: Stop ends it after the chat being read, as stopped', async () => {
  const chats = Array.from({ length: 6 }, (_, i) => ({ title: `Chat ${i + 1}`, unread: true, msgs: 2 }))
  const { r, final } = await sweepThrough(chats, { perScreen: 6, stopAfter: 2 })
  assert.equal(r.opened, 2)
  assert.equal(final.state, 'stopped')
  assert.equal(final.chatsRead, 2)
  assert.equal(final.messagesSeen, 4)
})
