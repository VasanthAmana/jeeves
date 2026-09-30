// A mimic of WhatsApp Web's page, for driving the app's guest scripts the way the <webview> does:
// scripts are serialized (guest.ts) and evaluated in a sandboxed context whose `document` is this
// page, and clicks arrive as trusted input at x/y coordinates (sendInputEvent). The DOM is a small
// stand-in with the markup WhatsApp uses — #pane-side rows with span[title], #main header, message
// rows keyed by data-id, a contenteditable composer in the footer, a context menu with "Reply" — so
// the app's real default selectors match it unmodified. It never sends anything on its own; a click
// on its Send button is recorded in `sent`, so a test can prove nothing was sent.
import vm from 'node:vm'

// ── A minimal DOM ─────────────────────────────────────────────────────────────────────────
type Rect = { x: number; y: number; w: number; h: number }
type AttrSel = { name: string; op: '' | '=' | '*=' | '^='; value: string; i: boolean }
type Compound = { tag: string | null; id: string | null; classes: string[]; attrs: AttrSel[] }

const parsed = new Map<string, Compound[][]>()

function splitTop(s: string, sep: (c: string) => boolean): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  let quote = ''
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '[') depth++
    else if (c === ']') depth--
    else if (depth === 0 && sep(c)) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}

function parseCompound(src: string): Compound {
  const c: Compound = { tag: null, id: null, classes: [], attrs: [] }
  let s = src
  const tag = /^([a-zA-Z][\w-]*|\*)/.exec(s)
  if (tag) {
    c.tag = tag[1] === '*' ? null : tag[1].toUpperCase()
    s = s.slice(tag[0].length)
  }
  while (s) {
    let m: RegExpExecArray | null
    if ((m = /^#([\w-]+)/.exec(s))) c.id = m[1]
    else if ((m = /^\.([\w-]+)/.exec(s))) c.classes.push(m[1])
    else if ((m = /^\[\s*([\w-]+)\s*(?:([*^]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*(i)?)?\s*\]/.exec(s)))
      c.attrs.push({ name: m[1], op: (m[2] ?? '') as AttrSel['op'], value: m[3] ?? m[4] ?? m[5] ?? '', i: !!m[6] })
    else throw new Error(`mimic DOM: unsupported selector "${src}"`)
    s = s.slice(m[0].length)
  }
  return c
}

function parse(sel: string): Compound[][] {
  let p = parsed.get(sel)
  if (!p) {
    p = splitTop(sel, (c) => c === ',').map((complex) => splitTop(complex, (c) => /\s/.test(c)).map(parseCompound))
    parsed.set(sel, p)
  }
  return p
}

function matchCompound(e: El, c: Compound): boolean {
  if (c.tag && e.tagName !== c.tag) return false
  if (c.id && e.getAttribute('id') !== c.id) return false
  const cls = e.className.split(/\s+/)
  if (!c.classes.every((k) => cls.includes(k))) return false
  return c.attrs.every((a) => {
    const v = e.getAttribute(a.name)
    if (v === null) return false
    const [have, want] = a.i ? [v.toLowerCase(), a.value.toLowerCase()] : [v, a.value]
    return a.op === '' ? true : a.op === '=' ? have === want : a.op === '*=' ? have.includes(want) : have.startsWith(want)
  })
}

function matches(e: El, sel: string): boolean {
  return parse(sel).some((chain) => {
    if (!matchCompound(e, chain[chain.length - 1])) return false
    let i = chain.length - 2
    for (let a = e.parent; a && i >= 0; a = a.parent) if (matchCompound(a, chain[i])) i--
    return i < 0
  })
}

export class El {
  tagName: string
  parent: El | null = null
  children: El[] = []
  text: string
  rect: Rect | null
  focusKey: string | null = null
  on: { click?: () => void; contextmenu?: () => void } = {}
  private attrs: Map<string, string>
  private page: MimicWhatsApp

  constructor(page: MimicWhatsApp, tag: string, attrs: Record<string, string> = {}, text = '', rect: Rect | null = null) {
    this.page = page
    this.tagName = tag.toUpperCase()
    this.attrs = new Map(Object.entries(attrs))
    this.text = text
    this.rect = rect
  }
  add(...kids: (El | null | false)[]): this {
    for (const k of kids) {
      if (!k) continue
      k.parent = this
      this.children.push(k)
    }
    return this
  }
  get attributes(): { name: string; value: string }[] {
    return [...this.attrs].map(([name, value]) => ({ name, value }))
  }
  getAttribute(n: string): string | null {
    return this.attrs.has(n) ? this.attrs.get(n)! : null
  }
  get className(): string {
    return this.attrs.get('class') ?? ''
  }
  get title(): string {
    return this.attrs.get('title') ?? ''
  }
  get innerText(): string {
    return [this.text, ...this.children.map((c) => c.innerText)].filter(Boolean).join('\n')
  }
  get textContent(): string {
    return [this.text, ...this.children.map((c) => c.textContent)].join('')
  }
  descendants(): El[] {
    return this.children.flatMap((c) => [c, ...c.descendants()])
  }
  querySelectorAll(sel: string): El[] {
    return this.descendants().filter((e) => matches(e, sel))
  }
  querySelector(sel: string): El | null {
    return this.querySelectorAll(sel)[0] ?? null
  }
  closest(sel: string): El | null {
    return matches(this, sel) ? this : (this.parent?.closest(sel) ?? null)
  }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    const r = this.rect ?? { x: 0, y: 0, w: 0, h: 0 }
    return { left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h }
  }
  focus(): void {
    this.page.focus = this.focusKey
  }
  scrollIntoView(): void {
    this.page.scrolledIntoView.push(this.getAttribute('data-id') ?? this.closest('[data-id]')?.getAttribute('data-id') ?? '')
  }
  dispatchEvent(): boolean {
    return true
  }
}

// ── The WhatsApp page ─────────────────────────────────────────────────────────────────────
export interface MimicMessage {
  dataId: string // WhatsApp's message key: <fromMe>_<chat JID>_<id>[_<participant>]
  sender: string
  text: string
  loaded?: boolean // false = scrolled too far back: not in the DOM
}
export interface MimicChat {
  jid: string
  title: string
  messages: MimicMessage[]
  onScreen?: boolean // false = further down the chat list (only reachable by search)
}

const ROW_H = 72
const MSG_H = 48

export class MimicWhatsApp {
  chats: MimicChat[]
  openJid: string | null = null
  search = ''
  menu: { dataId: string; x: number; y: number } | null = null
  quote: MimicMessage | null = null
  composer = ''
  focus: string | null = null
  selectAll = false
  menuHasReply = true
  replyAttachesQuote = true
  footerHint = ''
  // What a test asserts on:
  sent: string[] = [] // anything the Send button actually sent (must stay empty on the reply path)
  clicks: { x: number; y: number; button: string; hit: string }[] = []
  keys: string[] = []
  scrolledIntoView: string[] = []
  root!: El

  constructor(chats: MimicChat[]) {
    this.chats = chats
    this.render()
  }

  private el(tag: string, attrs: Record<string, string> = {}, text = '', rect: Rect | null = null): El {
    return new El(this, tag, attrs, text, rect)
  }

  /** Rebuild the DOM from state (WhatsApp's React re-renders; element identity doesn't survive). */
  render(): void {
    const e = this.el.bind(this)
    const listed = this.search
      ? this.chats.filter((c) => c.title.toLowerCase().includes(this.search.toLowerCase()))
      : this.chats.filter((c) => c.onScreen !== false)
    const searchBox = e('div', { contenteditable: 'true', role: 'textbox', title: 'Search input textbox' }, this.search, { x: 10, y: 60, w: 280, h: 30 })
    searchBox.focusKey = 'search'
    const rows = listed.map((c, i) => {
      const row = e('div', { role: 'row' }, '', { x: 0, y: 100 + i * ROW_H, w: 300, h: ROW_H }).add(e('span', { title: c.title, dir: 'auto' }, c.title))
      row.on.click = () => {
        this.openJid = c.jid
        this.quote = null
        this.composer = ''
      }
      return row
    })
    const side = e('div', { id: 'side' }).add(searchBox, e('div', { id: 'pane-side' }).add(e('div', { role: 'grid' }).add(...rows)))

    let main: El | null = null
    const chat = this.chats.find((c) => c.jid === this.openJid)
    if (chat) {
      const loaded = chat.messages.filter((m) => m.loaded !== false)
      const list = e('div', { role: 'application' }).add(
        ...loaded.map((m, i) => {
          const fromMe = m.dataId.startsWith('true_')
          const y = 100 + i * MSG_H
          const bubble = e('div', { class: 'copyable-text', 'data-pre-plain-text': `[10:0${i % 10}, 30/09/2026] ${m.sender}: ` }, '', {
            x: fromMe ? 800 : 400,
            y,
            w: 240,
            h: MSG_H - 8
          }).add(e('span', { class: 'selectable-text copyable-text', dir: 'ltr' }, m.text))
          bubble.on.contextmenu = () => {
            this.menu = { dataId: m.dataId, x: fromMe ? 780 : 420, y: y + 10 }
          }
          return e('div', { 'data-id': m.dataId, role: 'row', class: fromMe ? 'message-out' : 'message-in' }, '', { x: 320, y, w: 900, h: MSG_H }).add(
            e('span', { 'data-icon': fromMe ? 'tail-out' : 'tail-in' }),
            bubble
          )
        })
      )
      const composer = e('div', { contenteditable: 'true', role: 'textbox', 'aria-label': 'Type a message' }, this.composer, { x: 360, y: 740, w: 700, h: 40 })
      composer.focusKey = 'composer'
      const quotePanel = this.quote
        ? e('div', { 'aria-label': 'Quoted message' }, '', { x: 360, y: 690, w: 700, h: 44 }).add(
            e('span', {}, this.quote.dataId.startsWith('true_') ? 'You' : this.quote.sender),
            e('span', {}, this.quote.text)
          )
        : null
      let send: El | null = null
      if (this.composer.trim()) {
        send = e('button', { 'aria-label': 'Send' }, '', { x: 1080, y: 740, w: 40, h: 40 }).add(e('span', { 'data-icon': 'send' }))
        send.on.click = () => {
          this.sent.push((this.quote ? `[quoting ${this.quote.dataId}] ` : '') + this.composer)
          this.composer = ''
          this.quote = null
        }
      }
      main = e('div', { id: 'main' }).add(
        e('header', {}, '', { x: 320, y: 0, w: 900, h: 60 }).add(e('span', { dir: 'auto' }, chat.title), e('span', {}, 'click here for contact info')),
        list,
        e('footer').add(this.footerHint ? e('span', {}, this.footerHint) : null, quotePanel, e('div', { class: 'lexical-rich-text-input' }).add(composer), send)
      )
    }

    let menu: El | null = null
    if (this.menu) {
      const { dataId, x, y } = this.menu
      const labels = [...(this.menuHasReply ? ['Reply'] : []), 'React', 'Forward', 'Star']
      menu = e('div', { role: 'application' }).add(
        e('ul').add(
          ...labels.map((label, i) => {
            const li = e('li', { role: 'button', tabindex: '0' }, '', { x, y: y + i * 36, w: 160, h: 36 }).add(e('div', {}, label))
            li.on.click = () => {
              this.menu = null
              if (label === 'Reply') {
                this.quote = this.replyAttachesQuote ? (this.chats.flatMap((c) => c.messages).find((m) => m.dataId === dataId) ?? null) : null
                this.focus = 'composer'
              }
            }
            return li
          })
        )
      )
    }
    this.root = e('html').add(e('body').add(e('div', { id: 'app' }).add(side, main, menu)))
  }

  /** Trusted mouse input at a point (what sendInputEvent delivers): the topmost element's handler, bubbling up. */
  click(p: { x: number; y: number }, button: 'left' | 'right' = 'left'): void {
    const inside = (el: El): boolean => {
      const r = el.rect
      return !!r && p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h
    }
    // The topmost element under the point: the last one in paint (document) order — descendants
    // paint over their ancestors, later siblings (the open menu) over earlier ones.
    let hit: El | null = null
    const walk = (el: El): void => {
      if (inside(el)) hit = el
      for (const c of el.children) walk(c)
    }
    walk(this.root)
    const type = button === 'right' ? 'contextmenu' : 'click'
    let handled = 'nothing'
    for (let el: El | null = hit; el; el = el.parent) {
      const h = el.on[type]
      if (h) {
        h()
        handled = el.closest('[data-id]')?.getAttribute('data-id') ?? el.getAttribute('aria-label') ?? el.getAttribute('role') ?? el.tagName
        break
      }
    }
    if (type === 'click' && this.menu && handled === 'nothing') this.menu = null // click-away closes the menu
    this.clicks.push({ ...p, button, hit: handled })
    this.render()
  }

  key(k: string): void {
    this.keys.push(k)
    if (k === 'Escape') this.menu = null
    this.render()
  }

  /** document.execCommand, as the composer/search boxes (Lexical) respond to it. */
  private exec(cmd: string, value = ''): boolean {
    if (!this.focus) return false
    const cur = this.focus === 'composer' ? this.composer : this.search
    let next = cur
    if (cmd === 'selectAll') this.selectAll = true
    else if (cmd === 'insertText') next = (this.selectAll ? '' : cur) + value
    else if (cmd === 'delete') next = this.selectAll ? '' : cur.slice(0, -1)
    else return false
    if (cmd !== 'selectAll') this.selectAll = false
    if (this.focus === 'composer') this.composer = next
    else this.search = next
    this.render()
    return true
  }

  /** A sandboxed context whose globals are this page — where serialized guest scripts run. */
  context(): vm.Context {
    const document = {
      querySelector: (sel: string) => this.root.querySelector(sel),
      querySelectorAll: (sel: string) => this.root.querySelectorAll(sel),
      execCommand: (cmd: string, _ui?: boolean, value?: string) => this.exec(cmd, value),
      createRange: () => ({ selectNodeContents() {}, collapse() {} })
    }
    const window: Record<string, unknown> = { innerHeight: 800, document }
    return vm.createContext({ document, window, getSelection: () => null, Event: class {} })
  }

  /** A <webview>-like executeJavaScript over this page (results come back structured-cloned). */
  webview(): { executeJavaScript(code: string): Promise<unknown> } {
    const ctx = this.context()
    return { executeJavaScript: async (code: string) => structuredClone(await vm.runInContext(code, ctx)) }
  }
}
