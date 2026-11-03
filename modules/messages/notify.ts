import type { Conversation, Person } from './store'
import { canUse, type MessageDto, type MessagesDeps } from './service'

/**
 * Push for DMs, @mentions (C1) and thread replies to the thread's participants (C2). A mention is the composer's syntax
 * `@handle`, where a person's handles are their email's local part and their
 * name without spaces (case-insensitive) — a lookup against the member list,
 * not a guess at meaning. Recipients are never the author, never someone who
 * may not see the conversation, and never someone viewing it right now.
 * "Their push settings" = whether they turned push on (have a subscription).
 */

export const VIEWING_WINDOW_MS = 60_000

export function handlesOf(p: Person): string[] {
  const out = new Set<string>()
  const local = p.email.split('@')[0]?.toLowerCase()
  if (local) out.add(local)
  const compact = p.name.replace(/\s+/g, '').toLowerCase()
  if (compact) out.add(compact)
  const first = p.name.trim().split(/\s+/)[0]?.toLowerCase()
  if (first) out.add(first)
  return [...out]
}

export function mentionedIds(body: string, people: readonly Person[]): string[] {
  const tokens = new Set([...body.matchAll(/(?:^|[^\w@])@([\w.+-]+)/g)].map((m) => m[1].toLowerCase().replace(/[.]+$/, '')))
  if (tokens.size === 0) return []
  return people.filter((p) => handlesOf(p).some((h) => tokens.has(h))).map((p) => p.id)
}

export type PushPort = {
  hasSubscription(userId: string): Promise<boolean>
  send(userId: string, payload: { title: string; body: string; url: string; tag: string }): Promise<void>
}

const snippet = (body: string, max = 140) => {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** Who gets a push for this new message, and sends it. Returns the recipients. */
export async function notifyNewMessage(
  d: MessagesDeps,
  push: PushPort,
  c: Conversation,
  m: MessageDto,
): Promise<string[]> {
  const people = await d.directory.listPeople()
  const candidates = [
    ...(c.kind === 'dm' ? await d.store.memberIds(c.id) : mentionedIds(m.body, people)),
    // A thread reply reaches the thread's participants (its starter and everyone who replied).
    ...(m.parentId ? await d.store.threadParticipants(m.parentId) : []),
  ]
  const now = d.now ? d.now() : new Date()
  const viewing = new Set(await d.store.viewersSince(c.id, new Date(now.getTime() - VIEWING_WINDOW_MS)))
  const recipients: string[] = []
  for (const userId of new Set(candidates)) {
    if (userId === m.authorId || viewing.has(userId)) continue
    if (!(await canUse(d, userId, c))) continue
    if (!(await push.hasSubscription(userId))) continue
    recipients.push(userId)
  }
  const where = c.kind === 'dm' ? '' : ` in #${c.name}`
  const title = m.parentId ? `${m.authorName} replied in a thread${where}` : c.kind === 'dm' ? m.authorName : `${m.authorName}${where}`
  const body = m.body.trim() ? snippet(m.body) : m.attachments.map((a) => a.name).join(', ')
  for (const userId of recipients) {
    try {
      await push.send(userId, {
        title,
        body,
        url: `/messages?c=${encodeURIComponent(c.id)}${m.parentId ? `&t=${encodeURIComponent(m.parentId)}` : ''}`,
        tag: `messages-${c.id}`,
      })
    } catch (err) {
      console.error('[messages] push failed', { userId, conversationId: c.id, err })
    }
  }
  return recipients
}
