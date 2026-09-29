import type { NormalizedMessage } from '../../../shared/ipc-contract'

// Deterministic pre-filter (WAC-005) — the cheap tier before any LLM call, the app's
// "SLM-first, don't send everything to the model" discipline applied to chat (architecture
// §6.1). Removes obvious noise; it is NOT a classifier. Conservative on purpose: when unsure
// KEEP the message — a false drop loses an obligation, a false keep only widens a window a
// little. Pure function, unit-testable without Electron.

// Message kinds that never carry an obligation.
const NOISE_KINDS = new Set(['system', 'reaction', 'sticker', 'notification'])

// Automated / system notices WhatsApp injects into the transcript.
const AUTOMATED =
  /\b(messages and calls are end-to-end encrypted|you deleted this message|this message was deleted|this message couldn.?t load|waiting for this message|missed (voice|video) call|changed to a new number|created group|added you|left|changed the subject|changed this group's icon|security code changed)\b/i

/** True when the message is worth sending into a window. */
export function keepForAnalysis(msg: NormalizedMessage): boolean {
  if (NOISE_KINDS.has(msg.kind)) return false

  const text = (msg.text ?? '').trim()
  if (!text) return false // media without a caption carries no text obligation (transcription is WAC-021)
  if (AUTOMATED.test(text)) return false

  // A pure emoji / single-token reaction-like blip. Keep short-but-meaningful replies
  // ("done", "yes will do") — only drop content with no letters/digits at all.
  if (!/[a-z0-9]/i.test(text)) return false

  return true
}

/** Filter a batch of messages down to the analysis-worthy ones. */
export function prefilter(messages: NormalizedMessage[]): NormalizedMessage[] {
  return messages.filter(keepForAnalysis)
}
