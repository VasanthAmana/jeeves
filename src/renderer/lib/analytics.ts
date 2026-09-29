// Jeeves ships with no telemetry — this is a same-shaped no-op stand-in for the tracker the
// WhatsApp view calls, kept as a stub (rather than edited out of whatsapp-view.tsx) so that
// file stays a byte-for-byte copy of the feature it was extracted from. Wire in a real
// analytics provider here if you want one; nothing else needs to change.

export const Analytics = {
  WhatsApp: {
    linked: (): void => {},
    scanned: (_props: { count: number }): void => {},
    draftReply: (_props: { conversation_id?: string }): void => {}
  }
}
