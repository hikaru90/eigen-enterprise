import type { MessagesDeps } from './service'
import type { Conversation, Message, Person } from './store'
import { canUse, conversationTitle } from './service'

/**
 * A person's mentions for the notification bell (notifications.inbox): the
 * channel messages and thread replies whose @handles named them, as recorded
 * when each was posted or edited (message_mentions, 0205; the handles are
 * resolved by mentionedIds in notify.ts — a member-list lookup, the same the
 * push uses). Only conversations the person may see right now count, so a
 * private channel or a lost grant never leaks a message. DMs record none: a
 * DM is already the person's own unread.
 */

export const MENTIONS_LIMIT = 50

export type Mention = {
  messageId: string
  conversationId: string
  parentId: string | null
  /** `#channel` as the person sees it. */
  where: string
  author: { id: string; name: string }
  body: string
  at: string
}

export async function mentionsOf(d: MessagesDeps, userId: string): Promise<Mention[]> {
  const rows = (await d.store.mentionsOf(userId, MENTIONS_LIMIT)).filter((m) => m.authorId !== userId)
  if (rows.length === 0) return []
  const people = new Map<string, Person>((await d.directory.listPeople()).map((p) => [p.id, p]))
  const seen = new Map<string, Conversation | null>()
  const out: Mention[] = []
  for (const m of rows) {
    if (!seen.has(m.conversationId)) {
      const c = await d.store.getConversation(m.conversationId)
      seen.set(m.conversationId, c && c.kind === 'channel' && (await canUse(d, userId, c, 'view')) ? c : null)
    }
    const c = seen.get(m.conversationId)
    if (!c) continue
    out.push(toMention(m, `#${await conversationTitle(d, userId, c, people)}`, people.get(m.authorId)))
  }
  return out
}

function toMention(m: Message, where: string, author: Person | undefined): Mention {
  return {
    messageId: m.id,
    conversationId: m.conversationId,
    parentId: m.parentId,
    where,
    author: { id: m.authorId, name: author ? author.name.trim() || author.email : 'Former member' },
    body: m.body,
    at: m.createdAt.toISOString(),
  }
}
