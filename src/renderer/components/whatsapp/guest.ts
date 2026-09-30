// The one door into the WhatsApp <webview> guest page. Every script the pane runs there goes
// through here, because a guest-side throw is otherwise opaque: Electron only reports "Error
// occurred in handler for 'GUEST_VIEW_MANAGER_CALL': Script failed to execute" in the main log,
// and the real error stays in the guest's console.
//
// Guest code is written as REAL functions (type-checked + linted like the rest of the app) and
// serialized with Function#toString — never hand-built JS strings, whose escaping bugs (a '\n'
// inside a template literal becoming a raw newline) only show up as a SyntaxError in the guest.
// A guest function must be self-contained: no closures over module scope, inputs only via args.
//
// Each script is wrapped so it RETURNS a structured result instead of throwing; the runner skips
// the call while the guest page isn't ready, and logs the guest's actual error message.

export type GuestResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** The slice of Electron's <webview> this module drives. */
export interface GuestWebview {
  executeJavaScript(code: string): Promise<unknown>
}

/** Serialize `fn(...args)` into a guest script that resolves to a GuestResult and never rejects. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function guestScript<A extends unknown[]>(fn: (...args: A) => any, args: A): string {
  return (
    `(async()=>{try{return{ok:true,value:await (${fn.toString()})(...${JSON.stringify(args)})};}` +
    `catch(e){return{ok:false,error:String((e&&(e.stack||e.message))||e)};}})()`
  )
}

/**
 * Wrap a DATA script (the extraction recipe — possibly AI-rewritten, so it can't be a function)
 * the same way. The recipe is already validated to parse (heal.ts), so this catches its runtime
 * throws; the newline before `;return` keeps a trailing line comment from swallowing the wrapper.
 */
export function guestDataScript(code: string): string {
  return `(function(){try{\n${code}\n;return{ok:true,value:null};}catch(e){return{ok:false,error:String((e&&(e.stack||e.message))||e)};}})()`
}

function isResult(r: unknown): r is GuestResult<unknown> {
  return !!r && typeof r === 'object' && typeof (r as { ok?: unknown }).ok === 'boolean'
}

export interface Guest {
  /** Run a self-contained function in the guest page. Never rejects. */
  run<A extends unknown[], R>(label: string, fn: (...args: A) => R, ...args: A): Promise<GuestResult<Awaited<R>>>
  /** Run a data script (the recipe) in the guest page. Never rejects. */
  runData(label: string, code: string): Promise<GuestResult<null>>
  /** Mark the guest page loaded (dom-ready) or not (a main-frame navigation started). */
  setReady(ready: boolean): void
  isReady(): boolean
}

export function createGuest(wv: GuestWebview, log: (msg: string) => void = (m) => console.warn(m)): Guest {
  let ready = false
  const exec = async <T>(label: string, code: string): Promise<GuestResult<T>> => {
    if (!ready) return { ok: false, error: 'guest page not ready' }
    let r: unknown
    try {
      r = await wv.executeJavaScript(code)
    } catch (e) {
      // Not a guest throw (those come back as a result): the page navigated away mid-call, the
      // webview was torn down, or the returned value couldn't be cloned.
      const error = e instanceof Error ? e.message : String(e)
      log(`[wa-guest] ${label}: executeJavaScript failed: ${error}`)
      return { ok: false, error }
    }
    if (!isResult(r)) {
      log(`[wa-guest] ${label}: unexpected result from guest`)
      return { ok: false, error: 'unexpected result from guest' }
    }
    if (!r.ok) log(`[wa-guest] ${label}: guest error: ${r.error}`)
    return r as GuestResult<T>
  }
  return {
    run: (label, fn, ...args) => exec(label, guestScript(fn, args)),
    runData: (label, code) => exec(label, guestDataScript(code)),
    setReady: (v) => {
      ready = v
    },
    isReady: () => ready
  }
}
