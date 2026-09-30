import { getRecipe, setRecipe, DEFAULT_RECIPE } from './recipe'
import { completeText } from '../llm/complete'

// AI self-heal for the extraction recipe (the brittleness fix for WAC-004/019). When the recipe
// stops capturing (WhatsApp changed its markup), the renderer sends a STRUCTURE-ONLY diagnostic
// snapshot (no message text — privacy, WAC-016/017) and this module asks the LLM (the 'large' tier,
// Claude-Code-first) to rewrite the recipe against the new structure. The candidate is
// sanity-validated, persisted (old kept as last-known-good), and returned for the renderer to
// dry-run; a bad recipe is rolled back. The regenerated code is DATA executed only inside the
// sandboxed <webview> — it can never edit source or run in the app (see recipe.ts).

const CONTRACT = [
  'The recipe is ONE self-contained IIFE (starts with "(() => {" or "(function(){"), injected into',
  'the WhatsApp Web page. It must, using ONLY the DOM/JS of that page:',
  '• guard against double-run with window.__waCopilot;',
  "• for each message emit console.log('__WA_MSG__' + JSON.stringify({conversationId, conversationTitle,",
  "  messageId, from, direction:'incoming'|'outgoing', text, timestamp, kind:'text', isGroup}));",
  "  direction is outgoing when the message is the user's own; timestamp is epoch ms; messageId MUST be",
  "  WhatsApp's own message key (the row's data-id attribute, verbatim) — it identifies the exact chat",
  '  and message so the user can reply to it later;',
  "• emit console.log('__WA_STATE__' + ('linked'|'qr'|'unauthenticated'));",
  "• emit console.log('__WA_HEALTH__' + JSON.stringify({linked, domMsgs, captured, storeChats}))",
  '  periodically (captured = running count of emitted messages);',
  "• when window.__WA_DIAG_REQUEST is set, emit console.log('__WA_DIAG__' + JSON.stringify(structureOnlySnapshot))",
  '  where the snapshot contains ONLY tag/class/attribute STRUCTURE, never message text;',
  '• run on a MutationObserver + a 5s interval; be defensive (try/catch), never throw.',
  'Read the currently-open chat from the DOM. Preserve the same output contract exactly.',
  'Output ONLY the JavaScript — no markdown fences, no prose.'
].join('\n')

function stripFences(s: string): string {
  const t = s.trim()
  const m = t.match(/^```(?:js|javascript)?\s*([\s\S]*?)```$/)
  return (m ? m[1] : t).trim()
}

/** A regenerated recipe is only trustworthy if it parses and honours the message contract. */
function validate(js: string): boolean {
  if (!js || js.length < 200) return false
  if (!js.includes('__WA_MSG__') || !js.includes('__WA_STATE__')) return false
  try {
    // Parse-check only (never executed here — it runs solely in the webview sandbox).
    new Function(js)
    return true
  } catch {
    return false
  }
}

/**
 * Regenerate the recipe from a diagnostic snapshot. Returns the persisted candidate for the
 * renderer to dry-run, or null if unavailable/invalid. On null the caller keeps the current recipe.
 */
export async function healRecipe(diag: string, error?: string): Promise<{ recipe: string; engine: string } | null> {
  const current = getRecipe()
  const prompt =
    'You maintain a WhatsApp Web message-extraction recipe that has STOPPED capturing messages — ' +
    "WhatsApp changed its markup. Rewrite it to work against the page's CURRENT structure.\n\n" +
    'OUTPUT CONTRACT:\n' + CONTRACT + '\n\n' +
    (error ? `OBSERVED ERROR/SYMPTOM:\n${error}\n\n` : '') +
    'CURRENT (BROKEN) RECIPE:\n' + current.slice(0, 8000) + '\n\n' +
    'STRUCTURE-ONLY DIAGNOSTIC SNAPSHOT OF THE LIVE PAGE (no message text):\n' + diag.slice(0, 8000) + '\n\n' +
    'Return the corrected recipe (JavaScript IIFE only).'

  const r = await completeText({ user: prompt, tier: 'large', maxTokens: 4096 }) // 'large' = harder task
  if (!r) return null // no backend available → renderer keeps the current recipe
  const candidate = stripFences(r.text)
  if (!validate(candidate)) return null
  setRecipe(candidate) // persist (previous kept as last-known-good for rollback)
  return { recipe: candidate, engine: r.engine }
}

export { DEFAULT_RECIPE }
