/**
 * Pure view state for /messages: message merging, day separators and the
 * conversation list's reaction to live frames. Shared by the page and its tests.
 */

import { shownErrorOf, type ShownError } from '$lib/errors/agent-report'
import { attachmentMarker, quoteSnippet, type ReplyQuote } from './quote'

/**
 * A refused /api/messages request, carrying what the page shows: the server's
 * sentence and its agent report (`{ error, agent }`), or `fallback` (the
 * status line) when the answer carried no sentence.
 */
export class MessagesRequestError extends Error {
  readonly shown: ShownError
  constructor(body: unknown, fallback: string) {
    const shown = shownErrorOf(body) ?? { error: fallback, agent: null }
    super(shown.error)
    this.name = 'MessagesRequestError'
    this.shown = shown
  }
}

/** What a page shows for any failure: a refused request's report, or a browser failure's words. */
export function shownFailure(err: unknown): ShownError {
  if (err instanceof MessagesRequestError) return err.shown
  return { error: err instanceof Error ? err.message : String(err), agent: null }
}

export type ReactionView = { emoji: string; userIds: string[]; names: string[] }
export type AttachmentView = {
  fileId: string
  name: string
  mime: string
  size: number
  image: boolean
}
/** A voice message's kept recording (played above its transcript). */
export type VoiceClipView = { fileId: string; mime: string; size: number; durationMs: number }

export type MessageView = {
  id: string
  conversationId: string
  authorId: string
  authorName: string
  authorImage: string | null
  /** A person or an AI co-worker (shown with the AI mark). */
  authorKind: 'human' | 'coworker'
  body: string
  createdAt: string
  editedAt: string | null
  deleted: boolean
  parentId: string | null
  replyCount: number
  lastReplyAt: string | null
  replierIds: string[]
  reactions: ReactionView[]
  attachments: AttachmentView[]
  /** The dictated recording(s) of a voice message (its transcript is the body); empty otherwise. */
  voice: VoiceClipView[]
  /** A call line (posted by Calls when a call here ended); null for ordinary messages. */
  call: CallLineView | null
  /** The quoted original ("Reply"); null when this message quotes nothing. */
  replyTo: ReplyQuote | null
}

/** A call line's structured data (rendered as "Call, 4 min" / "Missed call"). */
export type CallLineView = {
  callId: string
  outcome: 'ended' | 'missed' | 'declined'
  durationSeconds: number | null
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
    if (f.action === 'created' || nextLog.some((x) => x.id === m.id))
      nextLog = mergeMessages(nextLog, [m])
  } else {
    if (thread && thread.parentId === m.parentId) replies = mergeMessages(replies ?? [], [m])
    const parent = f.parent
    if (parent && nextLog.some((x) => x.id === parent.id))
      nextLog = mergeMessages(nextLog, [parent])
  }
  if (f.action === 'edited' || f.action === 'deleted') {
    nextLog = refreshQuotes(nextLog, m)
    if (replies) replies = refreshQuotes(replies, m)
  }
  return { log: nextLog, replies }
}

/** Where a voice clip's recording is played from (members of the conversation only). */
export function voiceClipUrl(messageId: string, fileId: string): string {
  return `/api/messages/messages/${encodeURIComponent(messageId)}/voice/${encodeURIComponent(fileId)}`
}

/** The quote of `m` as the service builds it (the composer's preview; refreshed quotes after an edit/delete). */
export function quoteOf(m: MessageView): ReplyQuote {
  if (m.deleted)
    return {
      id: m.id,
      parentId: m.parentId,
      deleted: true,
      authorId: null,
      authorName: null,
      snippet: '',
      attachment: null,
      call: false,
    }
  return {
    id: m.id,
    parentId: m.parentId,
    deleted: false,
    authorId: m.authorId,
    authorName: m.authorName,
    snippet: quoteSnippet(m.body),
    // the recording first, as the service stores it: a dictated message is quoted as a voice message
    attachment: attachmentMarker([
      ...m.voice.map((v) => ({ name: 'Voice message', mime: v.mime })),
      ...m.attachments,
    ]),
    call: m.call !== null,
  }
}

/** Rebuilds the quotes of `original` in `list` (unchanged messages keep their identity). */
function refreshQuotes(list: MessageView[], original: MessageView): MessageView[] {
  if (!list.some((x) => x.replyTo?.id === original.id)) return list
  const q = quoteOf(original)
  return list.map((x) => (x.replyTo?.id === original.id ? { ...x, replyTo: q } : x))
}

/** Whether `me` reacted with this emoji. */
export const reactedBy = (r: ReactionView, me: string) => r.userIds.includes(me)

/** "Bea, Carl and 2 others" — the hover text for a reaction chip. */
export function reactionTitle(r: ReactionView): string {
  const names = r.names
  if (names.length <= 3)
    return names.length <= 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
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
export function mergeMessages(
  current: readonly MessageView[],
  incoming: readonly MessageView[],
): MessageView[] {
  const byId = new Map(current.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
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
  const fmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
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

export type MessageRow = { message: MessageView; grouped: boolean }

/**
 * Slack-style rows for one day: a message continues the previous one's group
 * (no avatar or name, its time in the gutter on hover) when the same person
 * wrote it within 5 minutes — unless either side has a thread, which always
 * starts a fresh row so its summary stays attached to a named message.
 */
export function messageRows(messages: readonly MessageView[]): MessageRow[] {
  return messages.map((m, i) => {
    const prev = messages[i - 1]
    return {
      message: m,
      grouped: continuesRun(prev, m) && m.replyCount === 0 && (prev?.replyCount ?? 0) === 0,
    }
  })
}

/** "just now", "5m ago", "2h ago", "yesterday", "3d ago", then the date. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  const s = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  const days = Math.floor(s / 86_400)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at)
}

/** "3 replies · last reply 2h ago" — the thread summary under a message. */
export function threadSummary(
  m: Pick<MessageView, 'replyCount' | 'lastReplyAt'>,
  now: Date = new Date(),
): string {
  const count = `${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}`
  return m.lastReplyAt ? `${count} · last reply ${relativeTime(m.lastReplyAt, now)}` : count
}

/** Inserts or replaces a conversation, channels first (by name), then DMs. */
export function upsertConversation(
  list: readonly ConversationView[],
  c: ConversationView,
): ConversationView[] {
  const rest = list.filter((x) => x.id !== c.id)
  const channels = [
    ...rest.filter((x) => x.kind === 'channel'),
    ...(c.kind === 'channel' ? [c] : []),
  ].sort((a, b) => a.title.localeCompare(b.title))
  const dms =
    c.kind === 'dm'
      ? [c, ...rest.filter((x) => x.kind === 'dm')]
      : rest.filter((x) => x.kind === 'dm')
  return [...channels, ...dms]
}

export function setUnread(
  list: readonly ConversationView[],
  id: string,
  unread: number,
): ConversationView[] {
  return list.map((c) => (c.id === id ? { ...c, unread } : c))
}
