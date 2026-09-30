import { useEffect, useState } from 'react'
import { invoke, on } from '@/services/ipc'
import type { WaSweepProgress } from '@shared/ipc-contract'

// Chat-sweep progress, as main reports it (whatsapp:sweepProgress — see src/main/whatsapp/progress.ts).
// The UI only renders what main pushes; it never counts from the page itself.

const IDLE: WaSweepProgress = {
  state: 'idle',
  chatsRead: 0,
  chatsTotal: null,
  chatsFound: 0,
  messagesSeen: 0,
  messagesNew: 0,
  current: null,
  currentMessages: 0,
  startedAt: null,
  endedAt: null,
  note: null
}

export function useSweepProgress(): WaSweepProgress {
  const [p, setP] = useState<WaSweepProgress>(IDLE)
  useEffect(() => {
    let live = true
    void invoke('wa:sweepProgress')
      .then((r) => {
        if (live) setP(r)
      })
      .catch(() => undefined)
    const off = on('whatsapp:sweepProgress', setP)
    return () => {
      live = false
      off()
    }
  }, [])
  return p
}

export const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`

/** "3 of 12 chats" once the total is known, else "3 chats read · 7 found so far". */
export function chatsLabel(p: WaSweepProgress): string {
  if (p.chatsTotal !== null) return `${p.chatsRead} of ${plural(p.chatsTotal, 'chat')}`
  return `${plural(p.chatsRead, 'chat')} read · ${p.chatsFound} found so far`
}

export function messagesLabel(p: WaSweepProgress): string {
  return `${plural(p.messagesSeen, 'message')} (${p.messagesNew} new)`
}
