import type { Conversation, Person } from './store'
import { coworkerSlugFromEmail } from '$lib/server/coworkers/handle'
import { canUse, listConversations, type MessageDto, type MessagesDeps } from './service'

/**
 * Push for DMs, @mentions (C1), thread replies to the thread's participants (C2)
 * and quoted replies to the quoted author. A mention is the composer's syntax
 * `@handle`, where a person's handles are their email's local part and their
 * name without spaces (case-insensitive) — a lookup against the member list,
 * not a guess at meaning. An AI co-worker has exactly one handle, its slug
 * (plan/phase-ai-coworkers.md C3): `@marketing`. Recipients are never the
 * author, never someone who may not see the conversation, never someone
 * viewing it right now, and never a co-worker (it has no device; it hears a
 * mention through its trigger, $lib/server/coworkers/turns.ts).
 * "Their push settings" = whether they turned push on (have a subscription).
 */

export const VIEWING_WINDOW_MS = 60_000

/** The one handle people write to reach someone: a co-worker's slug, a person's email local part. */
export function primaryHandle(p: Person): string {
  if (p.kind === 'coworker') return coworkerSlugFromEmail(p.email, p.id)
  const local = p.email.split('@')[0]?.toLowerCase()
  if (!local) throw new Error(`member ${p.id} has no email local part to mention them by`)
  return local
}

export function handlesOf(p: Person): string[] {
  if (p.kind === 'coworker') return [coworkerSlugFromEmail(p.email, p.id)]
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
  /** `badge`: the recipient's total unread across their conversations (the app-icon badge). */
  send(userId: string, payload: { title: string; body: string; url: string; tag: string; badge: number }): Promise<void>
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
    // A quoted reply reaches the quoted message's author.
    ...(m.replyTo?.authorId ? [m.replyTo.authorId] : []),
  ]
  const now = d.now ? d.now() : new Date()
  const viewing = new Set(await d.store.viewersSince(c.id, new Date(now.getTime() - VIEWING_WINDOW_MS)))
  const coworkers = new Set(people.filter((p) => p.kind === 'coworker').map((p) => p.id))
  const recipients: string[] = []
  for (const userId of new Set(candidates)) {
    if (userId === m.authorId || viewing.has(userId) || coworkers.has(userId)) continue
    if (!(await canUse(d, userId, c))) continue
    if (!(await push.hasSubscription(userId))) continue
    recipients.push(userId)
  }
  const where = c.kind === 'dm' ? '' : ` in #${c.name}`
  const title = m.parentId ? `${m.authorName} replied in a thread${where}` : c.kind === 'dm' ? m.authorName : `${m.authorName}${where}`
  // In a channel the quoted author learns it was them being answered; everyone else gets the plain title.
  const titleFor = (userId: string) =>
    !m.parentId && c.kind === 'channel' && m.replyTo?.authorId === userId ? `${m.authorName} replied to you${where}` : title
  const body = m.body.trim() ? snippet(m.body) : m.attachments.map((a) => a.name).join(', ')
  for (const userId of recipients) {
    try {
      const badge = (await listConversations(d, userId)).reduce((sum, c) => sum + c.unread, 0)
      await push.send(userId, {
        title: titleFor(userId),
        body,
        url: `/messages?c=${encodeURIComponent(c.id)}${m.parentId ? `&t=${encodeURIComponent(m.parentId)}` : ''}`,
        tag: `messages-${c.id}`,
        badge,
      })
    } catch (err) {
      console.error('[messages] push failed', { userId, conversationId: c.id, err })
    }
  }
  return recipients
}
