// The functions the WhatsApp pane runs INSIDE the guest page, via guest.ts (which serializes them
// with Function#toString). Each one must be self-contained — no references to module scope or
// imports, only its own args plus the page's globals — and return a structured-clonable value.
// Selectors are passed in (they're AI-healable data, see selectors.ts), never baked in.

export type Point = { x: number; y: number }

/** Enable the recipe's store + media reads and clear its run-once guard so a re-inject runs. */
export function armRecipe(): void {
  const w = window as unknown as Record<string, unknown>
  w.__waCopilot = false
  w.__WA_STORE_READ = true
  w.__WA_AUDIO_READ = true
}

/** Ask the running recipe to emit a structure-only diagnostic on its next tick. */
export function requestRecipeDiag(): void {
  ;(window as unknown as Record<string, unknown>).__WA_DIAG_REQUEST = true
}

/** First line of the open chat's header (its title), or '' when no chat is open. */
export function headerTitle(headerSel: string): string {
  const h = document.querySelector<HTMLElement>(headerSel)
  return ((h ? h.innerText : '').split('\n')[0] || '').trim()
}

/** Structure-only snapshot (tags/roles/data-icon/aria — never message text) for the action self-heal. */
export function actionDiagnostic(): string {
  type DiagNode = { tag: string; attrs: Record<string, string>; kids: DiagNode[] }
  const pick = (el: Element | null, d: number): DiagNode | null => {
    if (!el || d < 0) return null
    const a: Record<string, string> = {}
    for (let i = 0; i < el.attributes.length; i++) {
      const n = el.attributes[i].name
      if (n === 'class') a[n] = String(el.className || '').slice(0, 60)
      else if (/^data-|^aria-|^role$/.test(n)) a[n] = (el.getAttribute(n) || '').slice(0, 40)
    }
    const kids = Array.from(el.children)
      .slice(0, 8)
      .map((c) => pick(c, d - 1))
      .filter((k): k is DiagNode => !!k)
    return { tag: el.tagName, attrs: a, kids }
  }
  return JSON.stringify({
    footer: pick(document.querySelector('#main footer'), 3),
    popup: pick(document.querySelector('[role="listbox"]') || document.querySelector('#main [role="grid"]'), 2),
    sampleRow: pick(document.querySelector('#main div[data-id]'), 3),
    chatRow: pick(document.querySelector('#pane-side [role="row"]'), 2),
    header: pick(document.querySelector('#main header'), 2)
  })
}

/** Where to right-click a voice note to get its message menu: just right of its Play button. */
export function voiceMenuPoint(rowSel: string, voicePlaySel: string): Point | null {
  const r = document.querySelector(rowSel)
  const pb = r && r.querySelector(voicePlaySel)
  if (!pb) return null
  const b = pb.getBoundingClientRect()
  return { x: Math.round(b.right + 55), y: Math.round(b.top + b.height / 2) }
}

/** Centre of the open context menu's "Download" item. */
export function downloadMenuItemPoint(): Point | null {
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="button"],[role="menuitem"],li[role],div[role="button"],li'))
  for (const it of items) {
    if (/^download$/i.test((it.innerText || '').trim())) {
      const b = it.getBoundingClientRect()
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
    }
  }
  return null
}

/** Read an image message's full-res blob as base64. null = no image in the row, or too large. */
export async function imageBlob(rowSel: string, imageSel: string): Promise<{ b64: string; mime: string } | null> {
  const r = document.querySelector(rowSel)
  const im = r && r.querySelector<HTMLImageElement>(imageSel)
  if (!im) return null
  const b = await (await fetch(im.src)).blob()
  if (!b || b.size > 12_000_000) return null
  const url = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(fr.error || new Error('FileReader failed'))
    fr.readAsDataURL(b)
  })
  return { b64: url.split(',')[1] || '', mime: b.type || 'image/jpeg' }
}

/** Centre of the chat-list row whose title is exactly `title`. */
export function chatRowPoint(rowSel: string, titleSel: string, title: string): Point | null {
  const rows = Array.from(document.querySelectorAll(rowSel))
  for (const row of rows) {
    const t = row.querySelector(titleSel)
    if (t && (t.getAttribute('title') || t.textContent || '').trim() === title) {
      const b = row.getBoundingClientRect()
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
    }
  }
  return null
}

/**
 * Put `text` into an EMPTY composer (execCommand insertText is emoji-safe). Never clobbers a
 * draft the user is typing — WhatsApp's Lexical editor can't be reliably cleared.
 */
export function insertIntoComposer(composerSel: string, text: string): 'ok' | 'no-composer' | 'not-empty' {
  const c = document.querySelector<HTMLElement>(composerSel)
  if (!c) return 'no-composer'
  if ((c.innerText || '').trim()) return 'not-empty'
  c.focus()
  document.execCommand('insertText', false, text)
  return 'ok'
}

/** Focus the composer with the caret at the end (before typing the @mention). */
export function caretToComposerEnd(composerSel: string): boolean {
  const c = document.querySelector<HTMLElement>(composerSel)
  if (!c) return false
  c.focus()
  const r = document.createRange()
  r.selectNodeContents(c)
  r.collapse(false)
  const s = getSelection()
  if (!s) return false
  s.removeAllRanges()
  s.addRange(r)
  return true
}

/** Centre of a visible @mention autocomplete option matching `name` (alphanumerics only). */
export function mentionOptionPoint(optionSel: string, name: string): Point | null {
  const re = new RegExp(name, 'i')
  const cands = Array.from(document.querySelectorAll<HTMLElement>(optionSel))
  for (const c of cands) {
    if (!re.test((c.innerText || '').trim())) continue
    const b = c.getBoundingClientRect()
    if (b.width > 0 && b.height > 0) return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
  }
  return null
}

/** The send button's centre; 'empty' if the composer is empty (never fire a blank send); null if not found. */
export function sendButtonPoint(composerSel: string, sendSel: string): Point | 'empty' | null {
  const c = document.querySelector<HTMLElement>(composerSel)
  if (!c || !(c.innerText || '').trim()) return 'empty'
  const b = document.querySelector(sendSel)
  if (!b) return null
  const r = (b.closest('button') || b).getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
}

/** The composer's remaining text after a send ('' = sent); null if the composer is gone. */
export function composerText(composerSel: string): string | null {
  const c = document.querySelector<HTMLElement>(composerSel)
  return c ? (c.innerText || '').trim() : null
}

export type ChatRow = { title: string; x: number; y: number; unread: boolean }

/**
 * The chat-list rows currently fully on screen (fresh coords + unread state for the sweep). "On
 * screen" = inside the list's scrolling container (and the window), so the last row of a list that
 * runs to the bottom edge still counts once it's scrolled into view.
 */
export function visibleChatRows(rowSel: string, titleSel: string): ChatRow[] {
  const rows = Array.from(document.querySelectorAll(rowSel))
  const scrolls = (el: Element): boolean => {
    const oy = getComputedStyle(el).overflowY
    return el.scrollHeight > el.clientHeight + 1 && (oy === 'auto' || oy === 'scroll' || oy === 'overlay')
  }
  let sc: Element | null = rows[0] ? rows[0].parentElement : null
  while (sc && !scrolls(sc)) sc = sc.parentElement
  const vb = sc ? sc.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
  const top = Math.max(0, vb.top)
  const bottom = Math.min(window.innerHeight, vb.bottom)
  const out: ChatRow[] = []
  for (const r of rows) {
    const b = r.getBoundingClientRect()
    const te = r.querySelector(titleSel)
    const t = te ? (te.getAttribute('title') || te.textContent || '').trim() : ''
    const unread = !!r.querySelector('[aria-label*="unread" i]') || /\b\d+\s*unread\b/i.test(r.getAttribute('aria-label') || '')
    if (t && b.top >= top - 1 && b.bottom <= bottom + 1 && b.width > 120) {
      out.push({ title: t, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), unread })
    }
  }
  return out
}

/**
 * Scroll the chat list down about one screen, to reveal (and make WhatsApp render) more rows.
 * WhatsApp's list is virtualised: the role=grid is a tall box that does NOT scroll itself — an
 * ancestor (today #pane-side) does — so walk up from a row to whichever element actually scrolls
 * rather than trusting a fixed selector. `moved: false` = already at the end of the list.
 */
export function scrollChatList(rowSel: string): { moved: boolean } {
  const scrolls = (el: Element): boolean => {
    const oy = getComputedStyle(el).overflowY
    return el.scrollHeight > el.clientHeight + 1 && (oy === 'auto' || oy === 'scroll' || oy === 'overlay')
  }
  let el: Element | null = document.querySelector(rowSel) || document.querySelector('#pane-side')
  while (el && !scrolls(el)) el = el.parentElement
  const sc = el || document.querySelector('#pane-side')
  if (!sc) return { moved: false }
  const before = sc.scrollTop
  sc.scrollTop = before + Math.max(200, Math.round(sc.clientHeight * 0.8))
  return { moved: sc.scrollTop > before }
}

// ── Reply staging (reply-stager.ts) ──────────────────────────────────────────────────────────
// Open a stored message's exact chat, quote that message, and put a draft in the box. Nothing here
// ever sends — there's deliberately no send step on this path.

/** The open chat: its header title, how many message rows are loaded, and whether any is from `chatJid`. */
export function openChatCheck(headerSel: string, chatJid: string, messageId: string): { title: string; rows: number; jidRows: number; hasMessage: boolean } {
  const h = document.querySelector<HTMLElement>(headerSel)
  const title = ((h ? h.innerText : '').split('\n')[0] || '').trim()
  const rows = Array.from(document.querySelectorAll('#main [data-id]'))
  // A WhatsApp message key is <fromMe>_<chat JID>_<id>[_<participant>] — the chat JID is embedded.
  const jidRows = chatJid ? rows.filter((r) => (r.getAttribute('data-id') || '').indexOf('_' + chatJid + '_') > 0).length : 0
  const hasMessage = !!messageId && rows.some((r) => r.getAttribute('data-id') === messageId)
  return { title, rows: rows.length, jidRows, hasMessage }
}

/** Scroll a message into view and return a point on its bubble (for its context menu); null if not loaded. */
export function messageBubblePoint(messageId: string): Point | null {
  const row = Array.from(document.querySelectorAll('#main [data-id]')).find((r) => r.getAttribute('data-id') === messageId)
  if (!row) return null
  const bubble = row.querySelector('[data-pre-plain-text]') || row.querySelector('.copyable-text') || row.querySelector('.selectable-text') || row
  if (typeof (bubble as HTMLElement).scrollIntoView === 'function') (bubble as HTMLElement).scrollIntoView({ block: 'center' })
  const b = bubble.getBoundingClientRect()
  if (!(b.width > 0 && b.height > 0)) return null
  return { x: Math.round(b.left + Math.min(b.width / 2, 40)), y: Math.round(b.top + b.height / 2) }
}

/** Centre of the open context menu's item labelled exactly `label` (case-insensitive). */
export function menuItemPoint(label: string): Point | null {
  const want = String(label || '').trim().toLowerCase()
  if (!want) return null
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"],[role="button"],li[role],div[role="button"],li'))
  for (const it of items) {
    if ((it.innerText || '').trim().toLowerCase() !== want) continue
    const b = it.getBoundingClientRect()
    if (b.width > 0 && b.height > 0) return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
  }
  return null
}

/** Whether a reply-quote is attached above the composer: any of `expect` shows in the footer as a whole word/phrase, outside the box itself. */
export function quoteAttached(composerSel: string, expect: string[]): boolean {
  const c = document.querySelector<HTMLElement>(composerSel)
  const footer = (c && c.closest('footer')) || document.querySelector('#main footer')
  if (!footer) return false
  let text = footer.innerText || ''
  const typed = c ? c.innerText || '' : ''
  if (typed) text = text.split(typed).join(' ')
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const hay = norm(text)
  const word = (e: string): boolean => new RegExp('(?<![\\p{L}\\p{N}])' + e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'u').test(hay)
  return expect.map(norm).some((e) => e.length > 0 && word(e))
}

/** Type `query` into the chat-list search box (clearing it first). false = no search box. */
export function searchChats(searchSel: string, query: string): boolean {
  const s = document.querySelector<HTMLElement>(searchSel)
  if (!s) return false
  s.focus()
  if (s.tagName === 'INPUT') {
    ;(s as HTMLInputElement).value = query
    s.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  document.execCommand('selectAll', false)
  document.execCommand('insertText', false, query)
  return true
}

/** Empty the chat-list search box again (so the list goes back to normal). */
export function clearChatSearch(searchSel: string): void {
  const s = document.querySelector<HTMLElement>(searchSel)
  if (!s) return
  s.focus()
  if (s.tagName === 'INPUT') {
    ;(s as HTMLInputElement).value = ''
    s.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  document.execCommand('selectAll', false)
  document.execCommand('delete', false)
}
