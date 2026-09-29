// Ritual / greeting classifier (WAC — group-activity clubbing). Social-ritual messages (birthday
// wishes, good-morning/night, festival greetings, thanks) are HIGH volume + LOW information in
// group chats. They should not each become a topic or action item — they collapse into one
// frequency-counted "group activity" line. This is the cheap deterministic tier (no LLM): a short
// message matching a known ritual template, OR (in the batch) the same short text repeated across
// many senders, is clubbed. Long messages are always substantive (never clubbed).

export interface RitualKind {
  kind: string
  emoji: string
  label: string
}

// Order matters (first match wins). Kept intentionally broad incl. common Indian-English variants.
const RITUALS: { re: RegExp; kind: string; emoji: string; label: string }[] = [
  { re: /\b(happy\s*birthday|happy\s*bday|hbd|h\.?b\.?d|many\s*happy\s*returns|belated\s*birthday)\b/i, kind: 'birthday', emoji: '🎂', label: 'birthday wishes' },
  { re: /\b(happy\s*anniversary|wedding\s*anniversary)\b/i, kind: 'anniversary', emoji: '💐', label: 'anniversary wishes' },
  { re: /\b(good\s*morning|gud\s*morning|good\s*mrng|gm|g\.m\.|shubh\s*prabhat|subprabhat)\b/i, kind: 'good_morning', emoji: '☀️', label: 'good-morning messages' },
  { re: /\b(good\s*night|gud\s*night|gn|shubh\s*ratri|sweet\s*dreams)\b/i, kind: 'good_night', emoji: '🌙', label: 'good-night messages' },
  { re: /\b(happy\s*(diwali|deepavali|pongal|holi|new\s*year|christmas|eid|ramadan|ramzan|navratri|dussehra|dasara|onam|sankranti|makar\s*sankranti|ugadi|vishu|raksha\s*bandhan|ganesh\s*chaturthi)|merry\s*christmas|eid\s*mubarak|happy\s*festival)\b/i, kind: 'festival', emoji: '🪔', label: 'festival greetings' },
  { re: /\b(congrats|congratulations|congratz|hearty\s*congratulations)\b/i, kind: 'congrats', emoji: '🎉', label: 'congratulations' },
  { re: /\b(thank\s*you|thanks|thank\s*u|thx|thnx|thnks|you'?re\s*welcome|most\s*welcome)\b/i, kind: 'thanks', emoji: '🙏', label: 'thanks / you’re-welcome' }
]

// Rituals are short by nature. A longer message that merely contains "happy birthday" (e.g. planning
// a birthday party) is substantive — don't club it. Emoji/punctuation don't count toward length.
const MAX_RITUAL_LEN = 60

/** A known ritual/greeting template match, or null if the message is (likely) substantive. */
export function ritualClass(text: string): RitualKind | null {
  const t = (text ?? '').trim()
  const letters = t.replace(/[^a-z0-9]/gi, '')
  if (!letters || letters.length > MAX_RITUAL_LEN) return null
  for (const r of RITUALS) if (r.re.test(t)) return { kind: r.kind, emoji: r.emoji, label: r.label }
  return null
}

/** Normalised short-text key for near-duplicate clustering of NON-template repeats (batch only). */
export function normalizeForCluster(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}
