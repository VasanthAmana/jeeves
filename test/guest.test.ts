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
  const ctx = vm.createContext({ document, window, getSelection: () => null })
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
    composerText: ['footer [contenteditable]']
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
