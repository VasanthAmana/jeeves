import { getSetting, setSetting } from '../db/settings'
import { completeJSON } from '../llm/complete'

// Healable ACTION selectors (WAC-019 extended to the write/media path). The injected read-recipe
// already self-heals when it captures nothing; but the renderer-driven actions — open a chat,
// compose, @mention, click Send, grab a voice/image — use their own brittle WhatsApp selectors.
// Those live here as DATA so, when an action can't find its target, the renderer sends a structure-
// only diagnostic and an AI pass rewrites the failing selector(s). Same safety model as heal.ts:
// AI only ever returns CSS selector strings (never code), validated before they're persisted.

export type SelectorKey =
  | 'chatRow' // a row in the chat list (has a title span)
  | 'chatRowTitle' // the title element within a chat row
  | 'header' // the open chat's header (first line = chat name)
  | 'composer' // the message input box (contenteditable)
  | 'sendButton' // the Send button (visible once the composer has text)
  | 'mentionOption' // an option in the @mention autocomplete popup
  | 'voicePlay' // the play control of a voice-note message
  | 'imageBlob' // a photo's blob-backed <img>

export const DEFAULT_SELECTORS: Record<SelectorKey, string> = {
  chatRow: '#pane-side [role="row"]',
  chatRowTitle: 'span[title]',
  header: '#main header',
  composer: '#main footer div[contenteditable="true"], #main footer [role="textbox"]',
  sendButton: '#main footer [data-icon="send"], #main footer button[aria-label*="Send" i], #main footer span[data-icon="send"]',
  mentionOption: '#main [role="listbox"] [role="option"], #main [role="option"]',
  voicePlay: 'button[aria-label*="Play voice" i], [data-icon="ptt-status"]',
  imageBlob: 'img[src^="blob:"]'
}

// One-line description per key so the heal prompt knows what each selector must match.
const DESCRIPTIONS: Record<SelectorKey, string> = {
  chatRow: 'a single conversation row in the left chat list',
  chatRowTitle: 'the element inside a chat row holding the chat name (a title attribute)',
  header: 'the open conversation header whose first text line is the chat name',
  composer: 'the message input box you type into (a contenteditable / textbox)',
  sendButton: 'the button that sends the typed message (appears once the box has text)',
  mentionOption: 'a selectable person option in the @mention autocomplete popup',
  voicePlay: 'the play button of a voice-note (PTT) message',
  imageBlob: 'the thumbnail image element of a photo message (a blob-backed <img>)'
}

const SETTING = 'wa_action_selectors'
const BASE_SETTING = 'wa_action_selectors_base'
// BUMP when DEFAULT_SELECTORS changes so a heal from an older build doesn't shadow the new defaults.
const CODE_VERSION = '1'

/** Current action selectors: persisted heals (only if from the current code base) over the defaults. */
export function getSelectors(): Record<SelectorKey, string> {
  const merged = { ...DEFAULT_SELECTORS }
  if (getSetting(BASE_SETTING) === CODE_VERSION) {
    try {
      const saved = JSON.parse(getSetting(SETTING) || '{}') as Partial<Record<SelectorKey, string>>
      for (const k of Object.keys(merged) as SelectorKey[]) if (typeof saved[k] === 'string' && saved[k]) merged[k] = saved[k] as string
    } catch {
      /* corrupt — fall back to defaults */
    }
  }
  return merged
}

function persist(next: Record<SelectorKey, string>): void {
  setSetting(SETTING, JSON.stringify(next))
  setSetting(BASE_SETTING, CODE_VERSION)
}

/** Reset a healed selector (or all) back to the shipped default — the rollback for a bad heal. */
export function resetSelectors(key?: SelectorKey): Record<SelectorKey, string> {
  const cur = getSelectors()
  if (key) cur[key] = DEFAULT_SELECTORS[key]
  else return persistAndReturn({ ...DEFAULT_SELECTORS })
  return persistAndReturn(cur)
}
function persistAndReturn(next: Record<SelectorKey, string>): Record<SelectorKey, string> {
  persist(next)
  return next
}

/**
 * Ask the AI to rewrite the failing selector(s) from a STRUCTURE-ONLY DOM diagnostic (no message
 * text — privacy). Validates each result is a plausible CSS selector (parses, non-empty, no scripty
 * chars) before persisting. Returns the full, updated selector map (unchanged if the heal fails).
 */
export async function healSelectors(failing: SelectorKey[], diag: string): Promise<{ selectors: Record<SelectorKey, string>; healed: SelectorKey[]; engine?: string }> {
  const cur = getSelectors()
  const keys = failing.filter((k): k is SelectorKey => k in DEFAULT_SELECTORS)
  if (!keys.length) return { selectors: cur, healed: [] }
  const ask = keys.map((k) => `- "${k}": ${DESCRIPTIONS[k]} (current, broken: ${cur[k]})`).join('\n')
  const system =
    'You repair CSS selectors for automating WhatsApp Web after a DOM change. You are given a ' +
    'STRUCTURE-ONLY snapshot (tags, roles, data-icon/aria attributes — never message text) and a ' +
    'list of selector keys to fix. Return ONLY a JSON object mapping each key to a NEW CSS selector ' +
    'string that matches the described element in that structure. CSS selectors ONLY — never code, ' +
    'never JS. Prefer stable attributes (role, aria-label, data-icon) over generated class names.'
  const user = `Selectors to repair:\n${ask}\n\nStructure snapshot:\n${diag}\n\nReturn JSON: { "<key>": "<css selector>", ... }`
  const res = await completeJSON<Record<string, string>>({ system, user, tier: 'large', maxTokens: 800 })
  if (!res) return { selectors: cur, healed: [] }
  const healed: SelectorKey[] = []
  const next = { ...cur }
  for (const k of keys) {
    const v = res.data[k]
    if (typeof v === 'string' && isPlausibleSelector(v)) {
      next[k] = v.trim()
      healed.push(k)
    }
  }
  if (healed.length) persist(next)
  return { selectors: next, healed, engine: res.engine }
}

// A defensive check that the AI returned a CSS selector, not code: bounded length, no script-only
// characters, and it contains selector-ish tokens. The renderer also try/catches querySelector.
function isPlausibleSelector(s: string): boolean {
  const t = s.trim()
  if (!t || t.length > 300) return false
  if (/[{}`;]|=>|\bfunction\b|javascript:/i.test(t)) return false
  return /[.#[\]a-zA-Z*]/.test(t)
}
