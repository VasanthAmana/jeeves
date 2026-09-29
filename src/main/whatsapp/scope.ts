import { getSetting, setSetting } from '../db/settings'

// Analysis scope (WAC-015 extension) — an INCLUSION allow-list. When set, ONLY the listed chats
// are ingested/analysed and everything else is dropped at the boundary; when empty, all chats are
// in scope (the original exclusion-only behaviour). Matching is by slug so it's stable against
// title formatting. The slug function MUST match the recipe's (whatsapp/recipe.ts) exactly, since
// captured conversationIds are already slugs.

const INCLUDE_SETTING = 'wa_include'

export function slugifyTitle(t: string): string {
  return (t || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'chat'
}

/** The inclusion allow-list of chat titles. Empty ⇒ analyse ALL chats. */
export function getIncludeList(): string[] {
  try {
    const raw = getSetting(INCLUDE_SETTING)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

export function setIncludeList(titles: string[]): void {
  const clean = Array.from(new Set(titles.map((t) => t.trim()).filter(Boolean)))
  setSetting(INCLUDE_SETTING, JSON.stringify(clean))
}

/** The included titles as a set of slugs (empty when no allow-list is set). */
export function includedSlugs(): Set<string> {
  return new Set(getIncludeList().map(slugifyTitle))
}

/** True if a conversation (by id/slug or title) is in scope. Empty allow-list ⇒ everything in scope. */
export function isIncluded(conversationIdOrTitle: string): boolean {
  const slugs = includedSlugs()
  if (slugs.size === 0) return true
  return slugs.has(conversationIdOrTitle) || slugs.has(slugifyTitle(conversationIdOrTitle))
}
