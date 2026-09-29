// The model bound to WhatsApp topic/obligation extraction — one place to swap it, so it's a
// config edit rather than a change buried in analysis.ts. (llm/complete.ts's own MODELS table
// is the equivalent knob for the unified small/large tiers that draft.ts/heal.ts/selectors.ts
// route through; this one is specific to analysis.ts's direct Anthropic tool-call path.)

export const EXTRACTION_MODEL = 'claude-haiku-4-5'
