// Regression tests for the webview guest-script layer (src/renderer/components/whatsapp/guest.ts).
// Run: pnpm test  (Node's built-in runner; Node strips the TS types itself).
//
// The bug these guard: the chat sweep sent the guest `...split('\n')...` from inside a template
// literal, so the guest received a raw newline inside a string literal → "SyntaxError: Invalid or
// unexpected token" → Electron's opaque "Error occurred in handler for 'GUEST_VIEW_MANAGER_CALL':
// Script failed to execute". Scripts are now real functions run in a sandboxed context here, the
// same way the guest runs them: serialized with toString, no access to module scope.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createGuest, guestDataScript, guestScript, type GuestResult } from '../src/renderer/components/whatsapp/guest.ts'
import * as gs from '../src/renderer/components/whatsapp/guest-scripts.ts'

type Els = Record<string, unknown>

/** A bare guest page: only the DOM globals the scripts touch, answering from `els` by selector. */
function guestContext(els: Els = {}): vm.Context {
  const document = {
    querySelector: (sel: string) => els[sel] ?? null,
    querySelectorAll: (sel: string) => (Array.isArray(els[sel]) ? els[sel] : []),
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand: () => true
  }
  const window: Record<string, unknown> = { innerHeight: 800 }
  const getComputedStyle = (el: { style?: { overflowY?: string } }) => ({ overflowY: el.style?.overflowY ?? 'visible' })
  const ctx = vm.createContext({ document, window, getSelection: () => null, getComputedStyle })
  window.document = document
  return ctx
}

/**
 * Run a script the way webview.executeJavaScript does: evaluate it, await its completion value,
 * and hand back a copy (the real one is structured-cloned across IPC out of the guest's realm).
 */
async function runInGuest(code: string, ctx = guestContext()): Promise<GuestResult<unknown>> {
  return structuredClone(await vm.runInContext(code, ctx)) as GuestResult<unknown>
}

const scripts = Object.entries(gs).filter(([, v]) => typeof v === 'function') as [string, (...a: never[]) => unknown][]

test('every guest script compiles when serialized (no escaping SyntaxErrors)', () => {
  assert.ok(scripts.length > 10)
  for (const [name, fn] of scripts) {
    assert.doesNotThrow(() => new vm.Script(guestScript(fn, [] as never[])), `${name} must compile`)
  }
})

test('every guest script is self-contained and survives a page with none of its targets', async () => {
  // A page mid-load, logged out, or after a WhatsApp DOM change: nothing matches. Each script must
  // return a structured "not found" — a ReferenceError here means it closed over module scope.
  const args: Record<string, unknown[]> = {
    headerTitle: ['#main header'],
    voiceMenuPoint: ['#main div[data-id="x"]', 'button'],
    imageBlob: ['#main div[data-id="x"]', 'img'],
    chatRowPoint: ['[role="row"]', 'span[title]', 'Alpha'],
    insertIntoComposer: ['footer [contenteditable]', 'hi'],
    caretToComposerEnd: ['footer [contenteditable]'],
    mentionOptionPoint: ['[role="option"]', 'Bob'],
    sendButtonPoint: ['footer [contenteditable]', '[data-icon="send"]'],
    composerText: ['footer [contenteditable]'],
    visibleChatRows: ['#pane-side [role="row"]', 'span[title]'],
    scrollChatList: ['#pane-side [role="row"]']
  }
  for (const [name, fn] of scripts) {
    const r = await runInGuest(guestScript(fn, (args[name] ?? []) as never[]))
    assert.equal(r.ok, true, `${name}: ${r.ok ? '' : r.error}`)
  }
})

test("the sweep's header read returns the chat title's first line (was a guest SyntaxError)", async () => {
  const ctx = guestContext({ '#main header': { innerText: 'Alpha Team\nclick here for contact info' } })
  assert.deepEqual(await runInGuest(guestScript(gs.headerTitle, ['#main header']), ctx), { ok: true, value: 'Alpha Team' })
  assert.deepEqual(await runInGuest(guestScript(gs.headerTitle, ['#main header'])), { ok: true, value: '' })
})

test('the mention caret step reports a missing composer instead of throwing on null.focus()', async () => {
  const r = await runInGuest(guestScript(gs.caretToComposerEnd, ['#main footer [contenteditable]']))
  assert.deepEqual(r, { ok: true, value: false })
})

test('a guest throw or rejection comes back as a structured error carrying the real message', async () => {
  const thrown = await runInGuest(guestScript(() => (null as unknown as HTMLElement).focus(), []))
  assert.equal(thrown.ok, false)
  assert.match((thrown as { error: string }).error, /TypeError/)
  const rejected = await runInGuest(guestScript(async () => Promise.reject(new Error('blob fetch failed')), []))
  assert.equal(rejected.ok, false)
  assert.match((rejected as { error: string }).error, /blob fetch failed/)
})

test('the recipe (data) wrapper catches runtime throws and tolerates a trailing line comment', async () => {
  assert.deepEqual(await runInGuest(guestDataScript('window.__x = 1; // trailing comment')), { ok: true, value: null })
  const r = await runInGuest(guestDataScript('(() => { document.body.appendChild(null) })();'))
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /TypeError/)
})

test('the runner skips calls until the page is ready, and logs guest + transport errors', async () => {
  const logs: string[] = []
  const calls: string[] = []
  let reject = false
  const wv = {
    executeJavaScript: async (code: string): Promise<unknown> => {
      calls.push(code)
      if (reject) throw new Error('Script failed to execute')
      return runInGuest(code)
    }
  }
  const g = createGuest(wv, (m) => logs.push(m))

  assert.deepEqual(await g.run('headerTitle', gs.headerTitle, '#main header'), { ok: false, error: 'guest page not ready' })
  assert.equal(calls.length, 0)

  g.setReady(true)
  assert.deepEqual(await g.run('headerTitle', gs.headerTitle, '#main header'), { ok: true, value: '' })
  assert.equal(logs.length, 0)

  const r = await g.run('boom', () => {
    throw new Error('selector exploded')
  })
  assert.equal(r.ok, false)
  assert.match(logs.at(-1) ?? '', /\[wa-guest\] boom: guest error: .*selector exploded/)

  reject = true // e.g. the page navigated away mid-call
  assert.deepEqual(await g.run('headerTitle', gs.headerTitle, '#main header'), { ok: false, error: 'Script failed to execute' })
  assert.match(logs.at(-1) ?? '', /\[wa-guest\] headerTitle: executeJavaScript failed: Script failed to execute/)

  reject = false
  assert.equal((await g.runData('recipe', 'throw new Error("recipe broke")')).ok, false)
  assert.match(logs.at(-1) ?? '', /\[wa-guest\] recipe: guest error: .*recipe broke/)
})

/** A box with WhatsApp's scroll geometry; only one that has overflowY auto/scroll can scroll. */
function box(clientHeight: number, scrollHeight: number, overflowY: string, parentElement: unknown = null) {
  return {
    clientHeight,
    scrollHeight,
    style: { overflowY },
    parentElement,
    _top: 0,
    get scrollTop() {
      return this._top
    },
    set scrollTop(v: number) {
      this._top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight))
    }
  }
}

test('the chat list scrolls the element that actually scrolls, not the tall virtualised grid', async () => {
  // WhatsApp: #pane-side (overflow auto, 700px tall) > wrapper > role=grid (40 rows × 72px, no
  // overflow, so scrolling it does nothing) > row. The old script scrolled the grid; nothing moved.
  const pane = box(700, 2880, 'auto')
  const grid = box(2880, 2880, 'visible', box(2880, 2880, 'visible', pane))
  const row = box(72, 72, 'visible', grid)
  const ctx = guestContext({ '#pane-side [role="row"]': row, '#pane-side': pane })
  const scroll = () => runInGuest(guestScript(gs.scrollChatList, ['#pane-side [role="row"]']), ctx)

  assert.deepEqual(await scroll(), { ok: true, value: { moved: true } })
  assert.equal(pane.scrollTop, 560)
  assert.equal(grid.scrollTop, 0)
  for (let i = 0; i < 20; i++) {
    const r = await scroll()
    if (!r.ok || !(r.value as { moved: boolean }).moved) break
  }
  assert.equal(pane.scrollTop, 2180) // reached the bottom of the list
  assert.deepEqual(await scroll(), { ok: true, value: { moved: false } }) // and says so
})

test('rows count as on screen within the list container, including the last row at the window edge', async () => {
  // #pane-side spans y=110..860 (the window bottom). Rows: one clipped under the list's top edge,
  // two fully inside, and the list's LAST row ending exactly at the bottom edge — which the old
  // `bottom < innerHeight - 8` rule excluded, so the sweep could never open the last chat.
  const pane = { ...box(750, 2880, 'auto'), getBoundingClientRect: () => ({ top: 110, bottom: 860 }) }
  const grid = box(2880, 2880, 'visible', pane)
  const row = (title: string, top: number, unread = false) => ({
    parentElement: grid,
    getBoundingClientRect: () => ({ top, bottom: top + 72, height: 72, left: 0, width: 340 }),
    querySelector: (sel: string) =>
      sel === 'span[title]' ? { getAttribute: () => title, textContent: title } : sel.includes('unread') && unread ? {} : null,
    getAttribute: () => ''
  })
  const rows = [row('Clipped', 80), row('A', 152, true), row('B', 224), row('Last', 788)]
  const ctx = guestContext({ '#pane-side [role="row"]': rows })
  ;(ctx.window as { innerHeight: number }).innerHeight = 860
  const r = await runInGuest(guestScript(gs.visibleChatRows, ['#pane-side [role="row"]', 'span[title]']), ctx)
  assert.equal(r.ok, true)
  const got = (r as { value: { title: string; unread: boolean; y: number }[] }).value
  assert.deepEqual(got.map((x) => [x.title, x.unread, x.y]), [['A', true, 188], ['B', false, 260], ['Last', false, 824]])
})
