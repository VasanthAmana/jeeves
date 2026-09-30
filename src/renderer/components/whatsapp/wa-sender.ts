import type { WaReplyPlan, WaReplyStaged } from '@shared/ipc-contract'

// Bridge so the Topics view can drive the WhatsApp composer, which lives in LiveWhatsAppPane (it
// owns the <webview>). The pane registers its sender on mount; Topics calls sendWaTask(). The
// webview stays mounted even on the Topics tab (hidden), so this is available whenever WhatsApp is
// linked. Sending is an OUTBOUND action — callers must have shown a preview + got explicit confirm.

export interface WaTaskSend {
  conversationId: string
  conversationTitle: string
  text: string // the plain task line; the assignee is appended as a real @mention by the sender
  assignee: string // display name of a group participant to @mention (empty = no mention)
}

export type WaSenderFn = (p: WaTaskSend) => Promise<{ ok: boolean; error?: string }>

let _sender: WaSenderFn | null = null

/** LiveWhatsAppPane registers (and clears on unmount) its composer-driving sender here. */
export function registerWaSender(fn: WaSenderFn | null): void {
  _sender = fn
}

export function waSenderReady(): boolean {
  return !!_sender
}

export function sendWaTask(p: WaTaskSend): Promise<{ ok: boolean; error?: string }> {
  return _sender ? _sender(p) : Promise.resolve({ ok: false, error: 'Open the WhatsApp tab and link a phone to send.' })
}

// Reply staging: the pane registers a stager that opens a stored message's exact chat, quotes that
// message and puts a draft in the box (reply-stager.ts). It NEVER sends — the user presses Send in
// WhatsApp themselves — so it needs no confirm step, only the preview the reply panel shows.
export type WaReplyStagerFn = (plan: WaReplyPlan) => Promise<WaReplyStaged>

let _stager: WaReplyStagerFn | null = null

export function registerWaReplyStager(fn: WaReplyStagerFn | null): void {
  _stager = fn
}

export function waReplyStagerReady(): boolean {
  return !!_stager
}

export function stageWaReply(plan: WaReplyPlan): Promise<WaReplyStaged> {
  return _stager
    ? _stager(plan)
    : Promise.resolve({ opened: false, quoted: false, staged: false, note: 'Open the WhatsApp tab and link a phone to stage replies there.' })
}
