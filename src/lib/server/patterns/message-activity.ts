import type { ActivityEvent } from './digest'
import { and, eq, gte, isNull } from 'drizzle-orm'
import { companyDb } from '$lib/server/db'
import { messageConversations, messages } from '$lib/server/db/messages.schema'

/**
 * The messages a digest may count: posted since `since` in a public channel, the only place
 * every member can see. DMs, group DMs and private channels never count, for anyone — the
 * digest is one company-wide text, so a count from a conversation some viewer is not in would
 * tell them about it. Read from the messages table, not the audit trail, because a
 * `tool.executed` event does not say where a message went.
 */
export async function messageActivityEvents(since: Date): Promise<ActivityEvent[]> {
  const rows = await companyDb()
    .select({ principalId: messages.authorId, at: messages.createdAt })
    .from(messages)
    .innerJoin(messageConversations, eq(messageConversations.id, messages.conversationId))
    .where(
      and(
        gte(messages.createdAt, since),
        isNull(messages.deletedAt),
        isNull(messages.call),
        eq(messageConversations.kind, 'channel'),
        eq(messageConversations.private, false),
      ),
    )
  return rows.map((r) => ({ principalId: r.principalId, tool: 'messages.post', at: r.at }))
}
