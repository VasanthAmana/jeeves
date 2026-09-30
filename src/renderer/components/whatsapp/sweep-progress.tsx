import { chatsLabel, messagesLabel, plural } from './use-sweep-progress'
import type { WaSweepProgress } from '@shared/ipc-contract'

/** The sweep's live counts while it runs, then its final counts (finished or stopped). */
export function SweepProgressBadge({ progress: p, onDismiss }: { progress: WaSweepProgress; onDismiss?: () => void }): React.JSX.Element | null {
  if (p.state === 'idle') return null
  if (p.state === 'running') {
    return (
      <span className="inline-flex min-w-0 items-center gap-2 text-amber-300" role="status" aria-live="polite">
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-amber-400" />
        <span className="shrink-0">Reading chats: {chatsLabel(p)}</span>
        <span className="shrink-0 text-muted-foreground">· {messagesLabel(p)}</span>
        {p.current && (
          <span className="truncate text-muted-foreground" title={p.current}>
            · now: <span className="text-foreground">{p.current}</span> ({plural(p.currentMessages, 'message')})
          </span>
        )}
      </span>
    )
  }
  const stopped = p.state === 'stopped'
  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${stopped ? 'text-amber-300' : 'text-emerald-400'}`} role="status">
      <span className="shrink-0">
        {stopped ? '■ Stopped' : '✓ Finished'}: read {plural(p.chatsRead, 'chat')} · {messagesLabel(p)}
      </span>
      {p.note && (
        <span className="truncate text-muted-foreground" title={p.note}>
          · {p.note}
        </span>
      )}
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 text-muted-foreground hover:text-foreground" title="Hide">
          ✕
        </button>
      )}
    </span>
  )
}
