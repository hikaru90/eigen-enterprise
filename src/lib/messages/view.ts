/**
 * Pure view state for /messages: message merging, day separators and the
 * conversation list's reaction to live frames. Shared by the page and its tests.
 */

export type ReactionView = { emoji: string; userIds: string[]; names: string[] }
export type AttachmentView = { fileId: string; name: string; mime: string; size: number; image: boolean }

export type MessageView = {
  id: string
  conversationId: string
  authorId: string
  authorName: string
  body: string
  createdAt: string
  editedAt: string | null
  deleted: boolean
  parentId: string | null
  replyCount: number
  lastReplyAt: string | null
  reactions: ReactionView[]
  attachments: AttachmentView[]
}

/** A live message frame from /api/messages/stream. */
export type MessageFrame = {
  action: 'created' | 'edited' | 'deleted' | 'reacted'
  message: MessageView
  parent: MessageView | null
  unread: number
}

/**
 * Applies a live frame to the open conversation's main log and (when one is
 * open) the thread panel: replies go to their thread, never the main log; the
 * parent's fresh reply count replaces the one in the log.
 */
export function applyFrame(
  log: readonly MessageView[],
  thread: { parentId: string; replies: readonly MessageView[] } | null,
  f: MessageFrame,
): { log: MessageView[]; replies: MessageView[] | null } {
  const m = f.message
  let nextLog = [...log]
  let replies = thread ? [...thread.replies] : null
  if (m.parentId === null) {
    // Top-level: upsert only if new (created) or already shown (paged-out history stays out).
    if (f.action === 'created' || nextLog.some((x) => x.id === m.id)) nextLog = mergeMessages(nextLog, [m])
  } else {
    if (thread && thread.parentId === m.parentId) replies = mergeMessages(replies ?? [], [m])
    const parent = f.parent
    if (parent && nextLog.some((x) => x.id === parent.id)) nextLog = mergeMessages(nextLog, [parent])
  }
  return { log: nextLog, replies }
}

/** Whether `me` reacted with this emoji. */
export const reactedBy = (r: ReactionView, me: string) => r.userIds.includes(me)

/** "Bea, Carl and 2 others" — the hover text for a reaction chip. */
export function reactionTitle(r: ReactionView): string {
  const names = r.names
  if (names.length <= 3) return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} other${names.length - 3 === 1 ? '' : 's'}`
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
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
