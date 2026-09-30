// The chat-scan sweep must walk WhatsApp's whole chat list, scrolling as each screen is used up.
// Before the fix its scroll never moved the list (and every scroll counted as a failed attempt), so
// it only ever opened the chats on the first screen — and nothing at all once those were captured.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sweepChats, type SweepDeps } from '../src/renderer/components/whatsapp/sweep.ts'

type Chat = { title: string; unread: boolean }

/** A WhatsApp-like chat list: `perScreen` rows visible at a time, scrolled `step` rows per scroll. */
function fakeList(chats: Chat[], opts: { perScreen?: number; step?: number; skip?: (c: Chat) => boolean; scrollWorks?: boolean } = {}) {
  const perScreen = opts.perScreen ?? 8
  const step = opts.step ?? 6
  let top = 0
  let header = ''
  const opened: string[] = []
  let scrolls = 0
  const deps: Omit<SweepDeps, 'maxOpens'> = {
    visibleRows: async () =>
      chats.slice(top, top + perScreen).map((c, i) => ({ title: c.title, unread: c.unread, x: 100, y: 100 + i * 72 })),
    scroll: async () => {
      scrolls++
      if (opts.scrollWorks === false) return false
      const next = Math.min(top + step, Math.max(0, chats.length - perScreen))
      const moved = next > top
      top = next
      return moved
    },
    settle: async () => {},
    open: async (row) => {
      const c = chats.find((x) => x.title === row.title)!
      c.unread = false
      header = c.title
      opened.push(c.title)
    },
    header: async () => header,
    skip: (row) => !!opts.skip?.(chats.find((x) => x.title === row.title)!)
  }
  return { deps, opened, scrolls: () => scrolls }
}

const list = (n: number): Chat[] => Array.from({ length: n }, (_, i) => ({ title: `Chat ${i + 1}`, unread: i % 3 === 0 }))

test('the sweep scrolls through the whole list and opens every chat it should', async () => {
  const chats = list(40)
  const f = fakeList(chats)
  const r = await sweepChats({ ...f.deps, maxOpens: 100 })
  assert.equal(r.opened, 40)
  assert.equal(r.reachedEnd, true)
  assert.deepEqual([...f.opened].sort(), chats.map((c) => c.title).sort())
})

test('a later sweep scrolls past already-captured chats to reach the rest', async () => {
  const chats = list(40)
  const captured = new Set(chats.slice(0, 24).map((c) => c.title)) // earlier sweeps read these
  for (const c of chats) if (captured.has(c.title)) c.unread = false
  const f = fakeList(chats, { skip: (c) => !c.unread && captured.has(c.title) })
  const r = await sweepChats({ ...f.deps, maxOpens: 12 })
  assert.equal(r.opened, 12)
  assert.deepEqual(f.opened.slice(0, 1), ['Chat 25'])
  assert.ok(f.opened.every((t) => !captured.has(t)))
})

test('unread chats on screen are opened before never-captured ones, within the cap', async () => {
  const f = fakeList(list(40))
  const r = await sweepChats({ ...f.deps, maxOpens: 3 })
  assert.equal(r.opened, 3)
  assert.deepEqual(f.opened, ['Chat 1', 'Chat 4', 'Chat 7'])
})

test('it stops at the end of the list instead of spinning (and re-checks once for lazy loading)', async () => {
  const chats = list(5).map((c) => ({ ...c, unread: false }))
  const f = fakeList(chats, { skip: () => true, scrollWorks: false })
  const r = await sweepChats({ ...f.deps, maxOpens: 12 })
  assert.deepEqual(r, { opened: 0, reachedEnd: true })
  assert.equal(f.scrolls(), 2)
})
