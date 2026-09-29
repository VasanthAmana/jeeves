import { useEffect, useState } from 'react'
import { invoke, on } from '@/services/ipc'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { sendWaTask } from './wa-sender'
import type { WaTopicView, WaActivityView } from '@shared/ipc-contract'

// The Topics view: a conversation's matters as digest cards — title, status, summary,
// consolidated action items — each REFERENCING its actual message bits. You can move a bit to
// another topic (fixing miscategorisation; the move is pinned) and post a task back into the
// source chat, @mentioning a participant. Grouped by chat.

const STATUS_STYLE: Record<string, string> = {
  open: 'bg-amber-500/15 text-amber-300',
  waiting: 'bg-blue-500/15 text-blue-300',
  resolved: 'bg-emerald-500/15 text-emerald-300'
}
const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 }
const PRIORITY_STYLE: Record<string, string> = {
  high: 'bg-red-500/15 text-red-300',
  normal: 'bg-muted text-muted-foreground',
  low: 'bg-muted/40 text-muted-foreground/70'
}
const PRIORITY_SEQ = ['low', 'normal', 'high'] as const

export function TopicsView(): React.JSX.Element {
  const [topics, setTopics] = useState<WaTopicView[]>([])
  const [activity, setActivity] = useState<WaActivityView[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('wa:collapsedGroups') || '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())

  const refresh = (): void => {
    void invoke('wa:listTopics').then((r) => setTopics(r.topics))
    void invoke('wa:listActivity').then((r) => setActivity(r.activity))
  }
  useEffect(() => {
    refresh()
    return on('whatsapp:topicsChanged', refresh)
  }, [])

  const runRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await invoke('wa:refreshAnalysis')
      refresh()
    } finally {
      setRefreshing(false)
    }
  }
  const toggleCollapse = (id: string): void =>
    setCollapsed((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      localStorage.setItem('wa:collapsedGroups', JSON.stringify([...n]))
      return n
    })
  const toggleTag = (tag: string): void =>
    setTagFilter((prev) => {
      const n = new Set(prev)
      if (n.has(tag)) n.delete(tag)
      else n.add(tag)
      return n
    })

  // Tag cloud (for the filter bar) + the active-filter predicate (a topic matches ANY selected tag).
  const tagCounts = new Map<string, number>()
  for (const t of topics) for (const tag of t.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  const allTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const shown = tagFilter.size === 0 ? topics : topics.filter((t) => (t.tags ?? []).some((tag) => tagFilter.has(tag)))

  // Chat groups = the union of chats that have (filtered) topics and/or a group-activity digest.
  const order: string[] = []
  const byChat = new Map<string, { title: string; topics: WaTopicView[]; activity: WaActivityView[] }>()
  const bucket = (id: string, title: string): { title: string; topics: WaTopicView[]; activity: WaActivityView[] } => {
    let g = byChat.get(id)
    if (!g) {
      g = { title: title || id, topics: [], activity: [] }
      byChat.set(id, g)
      order.push(id)
    }
    return g
  }
  for (const t of shown) bucket(t.conversation_id, t.conversation_title).topics.push(t)
  if (tagFilter.size === 0) for (const a of activity) bucket(a.conversationId, a.conversationTitle).activity.push(a)
  // Within each chat: highest priority first, then most recent.
  for (const id of order)
    byChat.get(id)!.topics.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) || b.updated_at - a.updated_at)

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto max-w-3xl">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Topics &amp; group activity · auto-refreshes every 15 min</span>
          <Button size="xs" variant="secondary" disabled={refreshing} onClick={() => void runRefresh()}>
            {refreshing ? 'Refreshing…' : '↻ Refresh now'}
          </Button>
        </div>

        {/* Tag filter bar: click a tag to show only matching topics (across all chats). */}
        {allTags.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Filter:</span>
            {allTags.map(([tag, n]) => (
              <button
                key={tag}
                onClick={() => toggleTag(tag)}
                className={`rounded-full px-2 py-0.5 text-[11px] transition-colors ${
                  tagFilter.has(tag) ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground hover:bg-muted/70'
                }`}
              >
                #{tag} <span className="opacity-60">{n}</span>
              </button>
            ))}
            {tagFilter.size > 0 && (
              <button onClick={() => setTagFilter(new Set())} className="text-[11px] text-muted-foreground underline hover:text-foreground">
                clear
              </button>
            )}
          </div>
        )}

        {order.length === 0 ? (
          <div className="flex min-h-[40vh] items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {topics.length === 0 ? 'No topics yet. Once chats are read, each matter shows here as a card with its own action items.' : 'No topics match the selected tags.'}
          </div>
        ) : (
          <div className="space-y-4">
            {order.map((id) => {
              const c = byChat.get(id)!
              const isCollapsed = collapsed.has(id)
              const open = c.topics.filter((t) => t.status === 'open').length
              const high = c.topics.filter((t) => t.priority === 'high').length
              const actions = c.topics.reduce((s, t) => s + t.action_items.length, 0)
              return (
                <div key={id} className="rounded-lg border border-border/60">
                  <button
                    onClick={() => toggleCollapse(id)}
                    className="flex w-full items-center justify-between gap-3 rounded-t-lg px-3 py-2 text-left hover:bg-muted/40"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="text-xs text-muted-foreground">{isCollapsed ? '▸' : '▾'}</span>
                      <span className="truncate text-sm font-semibold text-foreground">{c.title}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{c.topics.length} topics</span>
                      {open > 0 && <span className="text-amber-300">{open} open</span>}
                      {high > 0 && <span className="text-red-300">{high} high</span>}
                      {actions > 0 && <span>{actions} actions</span>}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="space-y-3 px-3 pb-3">
                      {c.activity.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {c.activity.map((a) => (
                            <span
                              key={a.id}
                              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                              title={`${a.senderCount} people · ${a.senders.join(', ')}${a.senders.length < a.senderCount ? ', …' : ''}`}
                            >
                              <span>{a.emoji}</span>
                              <span className="font-medium text-foreground">{a.senderCount}</span>
                              <span>{a.label}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      {c.topics.map((t) => (
                        <TopicCard key={t.id} topic={t} siblings={c.topics} onChange={refresh} onFilterTag={toggleTag} activeTags={tagFilter} />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function TopicCard({
  topic,
  siblings,
  onChange,
  onFilterTag,
  activeTags
}: {
  topic: WaTopicView
  siblings: WaTopicView[]
  onChange: () => void
  onFilterTag: (tag: string) => void
  activeTags: Set<string>
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [assign, setAssign] = useState<{ participants: string[]; isGroup: boolean; assignee: string } | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  // Manual priority (cycles low→normal→high) + manual tags — both lock the field so re-extraction
  // won't overwrite the user's choice.
  const cyclePriority = async (): Promise<void> => {
    const cur = PRIORITY_SEQ.indexOf(topic.priority as (typeof PRIORITY_SEQ)[number])
    const next = PRIORITY_SEQ[(cur < 0 ? 1 : cur + 1) % PRIORITY_SEQ.length]
    await invoke('wa:setTopicPriority', topic.id, next)
    onChange()
  }
  const editTags = async (): Promise<void> => {
    const input = window.prompt('Tags (comma-separated) — for grouping/filtering similar topics:', (topic.tags ?? []).join(', '))
    if (input === null) return
    await invoke('wa:setTopicTags', topic.id, input.split(',').map((s) => s.trim()).filter(Boolean))
    onChange()
  }

  // The exact single line we'll post into the group (assignee appended as a real @mention by the sender).
  const taskText = `📋 Task: ${topic.title}`
  const openAssign = async (): Promise<void> => {
    setBusy('assign')
    setSent(null)
    try {
      const r = await invoke('wa:groupParticipants', topic.conversation_id)
      setAssign({ participants: r.participants, isGroup: r.isGroup, assignee: r.participants[0] ?? '' })
    } finally {
      setBusy(null)
    }
  }
  const confirmSend = async (): Promise<void> => {
    if (!assign) return
    setBusy('sending')
    try {
      const r = await sendWaTask({
        conversationId: topic.conversation_id,
        conversationTitle: topic.conversation_title || topic.conversation_id,
        text: taskText,
        assignee: assign.isGroup ? assign.assignee : ''
      })
      if (r.ok) {
        setSent(`Sent to ${topic.conversation_title}${assign.isGroup && assign.assignee ? ` · @${assign.assignee}` : ''}`)
        setAssign(null)
      } else {
        window.alert(r.error ?? 'Send failed')
      }
    } finally {
      setBusy(null)
    }
  }
  const move = async (messageId: string, value: string): Promise<void> => {
    if (value === '__new__') {
      const title = window.prompt('New topic title:')
      if (!title?.trim()) return
      await invoke('wa:moveMessage', messageId, { newTitle: title.trim() })
    } else if (value) {
      await invoke('wa:moveMessage', messageId, { topicId: value })
    }
    onChange()
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{topic.title}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${STATUS_STYLE[topic.status] ?? 'bg-muted text-muted-foreground'}`}>{topic.status}</span>
            <button
              onClick={() => void cyclePriority()}
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${PRIORITY_STYLE[topic.priority] ?? PRIORITY_STYLE.normal}`}
              title="Click to change priority (low → normal → high)"
            >
              {topic.priority}
            </button>
          </div>
          {topic.summary && <p className="mt-1 text-xs text-muted-foreground">{topic.summary}</p>}
          {/* Tags — click a tag to filter to similar topics; “edit” to add/remove (comma-separated). */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {(topic.tags ?? []).map((tag) => (
              <button
                key={tag}
                onClick={() => onFilterTag(tag)}
                className={`rounded-full px-2 py-0.5 text-[10px] ${activeTags.has(tag) ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground hover:bg-muted/70'}`}
                title="Filter to topics with this tag"
              >
                #{tag}
              </button>
            ))}
            <button onClick={() => void editTags()} className="text-[10px] text-muted-foreground hover:text-foreground" title="Add or edit tags">
              🏷 {topic.tags?.length ? 'edit' : 'add tags'}
            </button>
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="xs" variant="success" disabled={busy === 'assign'} onClick={() => void openAssign()}>
            Assign in WhatsApp
          </Button>
        </div>
      </div>

      {sent && <div className="mt-2 rounded bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300">✓ {sent}</div>}

      {/* Assign-in-WhatsApp preview + confirm. Nothing is sent until "Send" is pressed. OUTBOUND. */}
      {assign && (
        <div className="mt-2 rounded-md border border-border bg-background p-2.5 text-xs">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-medium text-foreground">Post task into “{topic.conversation_title}”</span>
            {!assign.isGroup && <span className="text-[10px] text-amber-300">1:1 chat — no @mention</span>}
          </div>
          {assign.isGroup &&
            (assign.participants.length > 0 ? (
              <label className="mb-2 flex items-center gap-2 text-muted-foreground">
                Assign to
                <select
                  className="rounded border border-border bg-background px-1.5 py-0.5 text-foreground"
                  value={assign.assignee}
                  onChange={(e) => setAssign({ ...assign, assignee: e.target.value })}
                >
                  {assign.participants.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <span className="text-[10px] text-muted-foreground">(@mentions them)</span>
              </label>
            ) : (
              <div className="mb-2 text-[11px] text-amber-300">No known participants yet — sends without a mention.</div>
            ))}
          <div className="mb-2 rounded bg-muted/50 p-2 font-mono text-[11px] text-foreground">
            {taskText}
            {assign.isGroup && assign.assignee ? ` @${assign.assignee}` : ''}
          </div>
          <div className="flex gap-2">
            <Button size="xs" variant="success" disabled={busy === 'sending'} onClick={() => void confirmSend()}>
              {busy === 'sending' ? 'Sending…' : `Send to ${topic.conversation_title}`}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setAssign(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {topic.action_items.length > 0 && (
        <div className="mt-2 space-y-1">
          {topic.action_items.map((a, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <Badge variant="secondary">{a.type.replace('_', ' ')}</Badge>
              <span className="text-foreground">{a.text}</span>
              {a.owner && <span className="text-muted-foreground">· {a.owner}</span>}
              {a.due && <span className="text-muted-foreground">· due {a.due}</span>}
            </div>
          ))}
        </div>
      )}

      {topic.messages.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">{topic.messages.length} message bits</summary>
          <div className="mt-1.5 space-y-1.5">
            {topic.messages.map((m) => (
              <div key={m.message_id} className="flex items-start gap-2 text-xs">
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${m.direction === 'outgoing' ? 'bg-emerald-800/40 text-emerald-200' : 'bg-muted text-muted-foreground'}`}>
                  {m.direction === 'outgoing' ? 'me' : m.sender ?? 'them'}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap text-muted-foreground">
                  {m.text}
                  {m.pinned && <span className="ml-1 text-[10px] text-amber-300" title="You moved this here — re-analysis won't move it">📌</span>}
                </span>
                <select
                  className="shrink-0 rounded border border-border bg-background px-1 py-0.5 text-[10px] text-muted-foreground"
                  value=""
                  onChange={(e) => void move(m.message_id, e.target.value)}
                  title="Move this message to another topic"
                >
                  <option value="">move…</option>
                  {siblings.filter((s) => s.id !== topic.id).map((s) => (
                    <option key={s.id} value={s.id}>
                      → {s.title}
                    </option>
                  ))}
                  <option value="__new__">→ New topic…</option>
                </select>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
