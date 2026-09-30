import { useEffect, useState } from 'react'
import { invoke } from '@/services/ipc'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { stageWaReply, waReplyStagerReady } from './wa-sender'
import type { WaReplyPlan, WaReplyStaged, WaReplyTarget } from '@shared/ipc-contract'

// Reply to one exact message (or an action item's evidence). main resolves the stored source and
// drafts a reply; "Stage in WhatsApp" then opens that chat, quotes that message and puts the draft
// in the message box (reply-stager.ts). Nothing is ever sent from here — the user presses Send in
// WhatsApp themselves.

export function ReplyPanel({
  target,
  onClose,
  onShowWhatsApp
}: {
  target: WaReplyTarget
  onClose: () => void
  onShowWhatsApp?: () => void
}): React.JSX.Element {
  const [plan, setPlan] = useState<WaReplyPlan | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<WaReplyStaged | null>(null)

  useEffect(() => {
    let live = true
    void invoke('wa:prepareReply', target)
      .then((r) => {
        if (!live) return
        if (r.ok && r.plan) {
          setPlan(r.plan)
          setDraft(r.plan.draft)
        } else setError(r.error ?? 'Couldn’t prepare a reply')
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [target])

  const stage = async (): Promise<void> => {
    if (!plan) return
    setBusy(true)
    setResult(null)
    try {
      setResult(await stageWaReply({ ...plan, draft }))
    } finally {
      setBusy(false)
    }
  }

  const q = plan?.quote
  const canStage = waReplyStagerReady()
  return (
    <div className="mt-2 rounded-md border border-border bg-background p-2.5 text-xs">
      {error ? (
        <div className="flex items-center gap-2">
          <span className="text-red-400">{error}</span>
          <span className="flex-1" />
          <Button size="xs" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : !plan ? (
        <span className="text-muted-foreground">Drafting a reply…</span>
      ) : (
        <>
          <div className="mb-1.5 font-medium text-foreground">Reply in “{plan.chatTitle}”</div>
          {q ? (
            <div className="mb-2 border-l-2 border-emerald-500/60 pl-2 text-muted-foreground">
              <span className="font-medium text-foreground">{q.direction === 'outgoing' ? 'You' : (q.sender ?? 'them')}</span>: {q.text}
              {q.status === 'title-only' && (
                <div className="mt-0.5 text-[10px] text-amber-300">
                  Saved before Jeeves kept message sources: the chat is reopened by its name, and this message may not be quotable.
                </div>
              )}
            </div>
          ) : (
            <div className="mb-2 text-[11px] text-muted-foreground">Replying to the chat (no specific message to quote).</div>
          )}
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} className="resize-y text-xs" />
          <div className="mt-1.5 text-[11px] text-muted-foreground">
            Nothing is sent: this opens the chat{q ? ', quotes the message' : ''} and puts the draft in WhatsApp’s message box. You press Send there.
          </div>
          {result && (
            <div className={`mt-2 rounded px-2 py-1 text-[11px] ${result.staged ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}>
              {result.staged
                ? `✓ Draft staged in “${plan.chatTitle}”${result.quoted ? ', quoting the message' : ''} — review it and press Send in WhatsApp.`
                : result.opened
                  ? `Opened “${plan.chatTitle}”, but the draft wasn’t staged.`
                  : 'Nothing was staged.'}
              {result.note && <div className="mt-0.5 text-muted-foreground">{result.note}</div>}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {canStage ? (
              <Button size="xs" variant="success" disabled={busy || !draft.trim()} onClick={() => void stage()}>
                {busy ? 'Staging…' : 'Stage in WhatsApp'}
              </Button>
            ) : (
              <span className="text-[11px] text-muted-foreground">Link WhatsApp (live mode) to stage it there, or copy it.</span>
            )}
            <Button size="xs" variant="secondary" onClick={() => void navigator.clipboard.writeText(draft)}>
              Copy
            </Button>
            {result?.opened && onShowWhatsApp && (
              <Button size="xs" variant="secondary" onClick={onShowWhatsApp}>
                Go to WhatsApp →
              </Button>
            )}
            <Button size="xs" variant="ghost" onClick={onClose}>
              {result?.staged ? 'Done' : 'Cancel'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
