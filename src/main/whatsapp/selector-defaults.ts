// The shipped default action selectors (see selectors.ts for how they're healed + persisted). Kept
// dependency-free so the tests can drive the mimic WhatsApp page with exactly these.

export type SelectorKey =
  | 'chatRow' // a row in the chat list (has a title span)
  | 'chatRowTitle' // the title element within a chat row
  | 'header' // the open chat's header (first line = chat name)
  | 'composer' // the message input box (contenteditable)
  | 'sendButton' // the Send button (visible once the composer has text)
  | 'mentionOption' // an option in the @mention autocomplete popup
  | 'voicePlay' // the play control of a voice-note message
  | 'imageBlob' // a photo's blob-backed <img>
  | 'chatSearch' // the chat-list search box (to find a chat that isn't on screen)

export const DEFAULT_SELECTORS: Record<SelectorKey, string> = {
  chatRow: '#pane-side [role="row"]',
  chatRowTitle: 'span[title]',
  header: '#main header',
  composer: '#main footer div[contenteditable="true"], #main footer [role="textbox"]',
  sendButton: '#main footer [data-icon="send"], #main footer button[aria-label*="Send" i], #main footer span[data-icon="send"]',
  mentionOption: '#main [role="listbox"] [role="option"], #main [role="option"]',
  voicePlay: 'button[aria-label*="Play voice" i], [data-icon="ptt-status"]',
  imageBlob: 'img[src^="blob:"]',
  chatSearch: '#side [contenteditable="true"][role="textbox"], #side div[contenteditable="true"], #side input[type="text"]'
}
