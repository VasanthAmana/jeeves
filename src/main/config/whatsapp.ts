// Runtime config for the WhatsApp connector. Defaults to MOCK so the whole
// observation → extraction → suggestion spine is runnable offline with no linked phone. Live
// wiring (an embedded WhatsApp Web session + DOM message detection) is guarded entirely by
// mode === 'live'; no WhatsApp Web page is ever loaded in mock mode. The mock source seeds a
// scripted demo conversation so the inbox lights up on connect.

export type WhatsappMode = 'mock' | 'live'

function mode(name: string): WhatsappMode {
  return process.env[name] === 'live' ? 'live' : 'mock'
}

export const whatsappConfig = {
  mode: mode('PA_WHATSAPP_MODE'),
  // One partition = one linked phone. Live only.
  partition: process.env.PA_WHATSAPP_PARTITION ?? 'persist:whatsapp',
  // The embedded WhatsApp Web URL the live <webview> loads (QR appears when the partition is unlinked).
  url: process.env.PA_WHATSAPP_URL ?? 'https://web.whatsapp.com',
  // A plain Chrome UA — WhatsApp Web rejects the default Electron UA ("update your browser").
  userAgent:
    process.env.PA_WHATSAPP_UA ??
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  // How often the live detector sweeps the open chat for messages the observer missed.
  sweepIntervalMs: Number(process.env.PA_WHATSAPP_SWEEP_MS ?? 15_000)
} as const
