/**
 * Pure view state for /messages: message merging, day separators and the
 * conversation list's reaction to live frames. Shared by the page and its tests.
 */

export type MessageView = {
  id: string
  conversationId: string
  authorId: string
  authorName: string
  body: string
  createdAt: string
  editedAt: string | null
  deleted: boolean
}

export type ConversationView = {
  id: string
  kind: 'channel' | 'dm'
  title: string
  topic: string
  private: boolean
  unread: number
  memberIds: string[]
}

/** Upserts by id and keeps time order (oldest first). */
export function mergeMessages(current: readonly MessageView[], incoming: readonly MessageView[]): MessageView[] {
  const byId = new Map(current.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

export type DayGroup = { key: string; label: string; messages: MessageView[] }

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Local-day groups with "Today" / "Yesterday" / a date label. */
export function groupByDay(messages: readonly MessageView[], now: Date = new Date()): DayGroup[] {
  const today = dayKey(now)
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  const yesterday = dayKey(y)
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const groups: DayGroup[] = []
  for (const m of messages) {
    const at = new Date(m.createdAt)
    const key = dayKey(at)
    let g = groups.at(-1)
    if (!g || g.key !== key) {
      const label = key === today ? 'Today' : key === yesterday ? 'Yesterday' : fmt.format(at)
      groups.push((g = { key, label, messages: [] }))
    }
    g.messages.push(m)
  }
  return groups
}

/** True when `m` continues the previous message's run (same author within 5 minutes). */
export function continuesRun(prev: MessageView | undefined, m: MessageView): boolean {
  if (!prev || prev.authorId !== m.authorId) return false
  return new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000
}

/** Inserts or replaces a conversation, channels first (by name), then DMs. */
export function upsertConversation(list: readonly ConversationView[], c: ConversationView): ConversationView[] {
  const rest = list.filter((x) => x.id !== c.id)
  const channels = [...rest.filter((x) => x.kind === 'channel'), ...(c.kind === 'channel' ? [c] : [])].sort((a, b) =>
    a.title.localeCompare(b.title),
  )
  const dms = c.kind === 'dm' ? [c, ...rest.filter((x) => x.kind === 'dm')] : rest.filter((x) => x.kind === 'dm')
  return [...channels, ...dms]
}

export function setUnread(list: readonly ConversationView[], id: string, unread: number): ConversationView[] {
  return list.map((c) => (c.id === id ? { ...c, unread } : c))
}
