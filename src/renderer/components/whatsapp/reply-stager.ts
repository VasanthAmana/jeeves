import type { Guest } from './guest'
import * as gs from './guest-scripts'
import type { WaReplyPlan, WaReplyStaged } from '@shared/ipc-contract'

// Stage a reply in WhatsApp Web: open the stored message's EXACT chat, quote that exact message
// (WhatsApp's own "Reply"), and put the draft in the message box — then stop. There is no send step
// on this path at all: the user reviews the staged reply in WhatsApp and presses Send themselves.
//
// Each step degrades rather than guessing: a chat that can't be confirmed isn't staged into (two
// chats can share a name — WhatsApp's own chat id tells them apart), a
// message that isn't loaded (or has no Reply in its menu) is left unquoted, and a message box that
// already holds the user's own text is never touched. The outcome says what happened in plain words.
// Kept free of React so it runs against a mimic WhatsApp page in the tests.

export interface StageDeps {
  guest: Guest
  sels: () => Record<string, string> // the live (healable) action selectors
  click: (p: gs.Point) => void // trusted left click (sendInputEvent)
  rightClick: (p: gs.Point) => void // trusted right click — opens WhatsApp's message menu
  escape: () => void // trusted Escape — closes a menu we opened
  sleep: (ms: number) => Promise<void>
  heal?: (keys: string[]) => Promise<string[]> // AI-heal stale selectors (WAC-019)
}

const OPEN_WAIT_MS = 1200
const SEARCH_WAIT_MS = 900
const MENU_WAIT_MS = 600
const QUOTE_WAIT_MS = 400

// opened: a chat with the plan's name is open. confirmed: it's the plan's exact chat (or there's no
// WhatsApp id to check it against), so it's safe to stage into.
type Opened = { opened: boolean; confirmed: boolean; note?: string }

async function run<T>(d: StageDeps, label: string, fallback: T, fn: (...a: never[]) => T | Promise<T>, ...args: unknown[]): Promise<T> {
  const r = await d.guest.run(label, fn as (...a: unknown[]) => T, ...args)
  return r.ok ? (r.value as T) : fallback
}

async function checkOpen(d: StageDeps, plan: WaReplyPlan): Promise<Opened | null> {
  const c = await run(d, 'openChatCheck', null, gs.openChatCheck, d.sels().header, plan.chatJid ?? '', plan.quote?.messageId ?? '')
  if (!c || c.title !== plan.chatTitle) return null
  // Same name is not the same chat: confirm with WhatsApp's own ids when we have them.
  if (!plan.chatJid || c.hasMessage || c.jidRows > 0 || c.rows === 0) return { opened: true, confirmed: true }
  return {
    opened: true,
    confirmed: false,
    note: `Opened a chat named “${plan.chatTitle}”, but it isn't the chat the message came from (its WhatsApp id doesn't match), so the draft wasn't staged there.`
  }
}

async function rowPoint(d: StageDeps, title: string): Promise<gs.Point | null> {
  const s = d.sels()
  return run(d, 'chatRowPoint', null, gs.chatRowPoint, s.chatRow, s.chatRowTitle, title)
}

/** Open the plan's chat: already open → its row in the list → search for it. */
export async function openChat(d: StageDeps, plan: WaReplyPlan): Promise<Opened> {
  const already = await checkOpen(d, plan)
  if (already) return already

  let p = await rowPoint(d, plan.chatTitle)
  let searched = false
  if (!p) {
    // Not on screen: search the chat list for it.
    let ok = await run(d, 'searchChats', false, gs.searchChats, d.sels().chatSearch, plan.chatTitle)
    if (!ok && d.heal && (await d.heal(['chatSearch'])).length) ok = await run(d, 'searchChats', false, gs.searchChats, d.sels().chatSearch, plan.chatTitle)
    if (ok) {
      searched = true
      await d.sleep(SEARCH_WAIT_MS)
      p = await rowPoint(d, plan.chatTitle)
    }
  }
  if (!p && d.heal && (await d.heal(['chatRow', 'chatRowTitle'])).length) p = await rowPoint(d, plan.chatTitle)
  if (p) {
    d.click(p)
    await d.sleep(OPEN_WAIT_MS)
  }
  if (searched) await run(d, 'clearChatSearch', undefined, gs.clearChatSearch, d.sels().chatSearch)
  return (await checkOpen(d, plan)) ?? { opened: false, confirmed: false, note: `Couldn't open “${plan.chatTitle}” in WhatsApp — nothing was staged.` }
}

/** Attach WhatsApp's reply-quote of the plan's message. Returns why not, when it couldn't. */
export async function quoteMessage(d: StageDeps, plan: WaReplyPlan): Promise<{ quoted: boolean; note?: string }> {
  const q = plan.quote
  if (!q) return { quoted: false }
  const bubble = await run(d, 'messageBubblePoint', null, gs.messageBubblePoint, q.messageId)
  if (!bubble) {
    const why =
      q.status === 'title-only'
        ? 'this message was saved before Jeeves kept message sources, so it can’t be found in the chat'
        : 'that message isn’t loaded in the chat (it may be too far back)'
    return { quoted: false, note: `Couldn't quote the message — ${why}.` }
  }
  d.rightClick(bubble)
  await d.sleep(MENU_WAIT_MS)
  const item = await run(d, 'menuItemPoint', null, gs.menuItemPoint, 'Reply')
  if (!item) {
    d.escape()
    return { quoted: false, note: 'Couldn’t quote the message — WhatsApp’s message menu had no “Reply” option.' }
  }
  d.click(item)
  await d.sleep(QUOTE_WAIT_MS)
  // The quote panel shows the message's text (or, for media, its sender) above the box.
  const expect = [q.text.slice(0, 40), q.direction === 'outgoing' ? '' : (q.sender ?? '')].filter((t) => t.trim().length >= 3)
  const quoted = await run(d, 'quoteAttached', false, gs.quoteAttached, d.sels().composer, expect)
  return quoted ? { quoted: true } : { quoted: false, note: 'Clicked “Reply” on the message, but couldn’t confirm the quote is attached — check it before sending.' }
}

/** Put the draft into the message box — only if the box is empty (never clobber the user's text). */
export async function stageDraft(d: StageDeps, text: string): Promise<{ staged: boolean; note?: string }> {
  const insert = (): Promise<'ok' | 'no-composer' | 'not-empty' | 'err'> =>
    run(d, 'insertIntoComposer', 'err' as const, gs.insertIntoComposer, d.sels().composer, text)
  let r = await insert()
  if (r === 'no-composer' && d.heal && (await d.heal(['composer'])).length) r = await insert()
  if (r === 'ok') return { staged: true }
  if (r === 'not-empty') return { staged: false, note: 'The message box already has text in it, so the draft wasn’t added — copy it in yourself.' }
  return { staged: false, note: 'Couldn’t find WhatsApp’s message box — copy the draft in yourself.' }
}

/** Open → quote → stage. Never sends. */
export async function stageReply(d: StageDeps, plan: WaReplyPlan): Promise<WaReplyStaged> {
  const notes: string[] = []
  const open = await openChat(d, plan)
  if (open.note) notes.push(open.note)
  if (!open.opened || !open.confirmed) return { opened: open.opened, quoted: false, staged: false, note: notes.join(' ') }
  const q = await quoteMessage(d, plan)
  if (q.note) notes.push(q.note)
  const s = await stageDraft(d, plan.draft)
  if (s.note) notes.push(s.note)
  return { opened: true, quoted: q.quoted, staged: s.staged, ...(notes.length ? { note: notes.join(' ') } : {}) }
}
