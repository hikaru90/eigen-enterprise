import type { RunSummary } from '$lib/agent-runs/feed'
import { runTitle } from '$lib/agent-runs/titles'
import { sessionIdOfConversationKey } from '$lib/kernel/engines/durable'
import {
  DbDurableConversationIndex,
  type DurableConversationIndex,
} from '$lib/server/agent/conversation-index'
import { openedDurableHarness, type DurableHarnessBox } from '$lib/server/agent/durable-harness'
import type { AgentEventStream } from '$lib/server/agent/pi-durable'

/** A rename's outcome: the renamed run, or why not (403: not the owner). */
export type RenameRunResult =
  | { ok: true; run: RunSummary }
  | { ok: false; status: 403 | 404; error: string }

/**
 * The D8 run view's read port over the durable agent: the run list comes from
 * the Postgres conversation index (D7), one run's live events from the
 * process harness (`DurableHarnessBox.events`). Narrow adapter over the
 * existing exports of src/lib/server/agent/*. Its one write is a member
 * renaming their own conversation (`user_title`, Contribute 495e40bb).
 */
export type AgentRunsSource = {
  /** Every run, newest activity first; `renamable` is from the viewer's side. */
  list(viewerUserId: string): Promise<RunSummary[]>
  /**
   * Give a run its own name. Only the run's owner (the member it ran for,
   * `llm_user_id`) may; the title must already be validated (renameRunBody).
   */
  rename(viewerUserId: string, runId: number, title: string): Promise<RenameRunResult>
  /** The run's live event stream, or null when the index has no such run. */
  watch(runId: number): Promise<AgentEventStream | null>
}

export function createAgentRunsSource(deps: {
  index: DurableConversationIndex
  harness: () => Promise<Pick<DurableHarnessBox, 'events'>>
  /** Display names for the chatting members' user ids (missing ids are unknown). */
  memberNames?: (userIds: string[]) => Promise<ReadonlyMap<string, string>>
  /** A chat's first message per chat session id (missing ids have none yet). */
  chatTopics?: (sessionIds: string[]) => Promise<ReadonlyMap<string, string>>
}): AgentRunsSource {
  const list = async (viewerUserId: string): Promise<RunSummary[]> => {
    const rows = await deps.index.listConversations()
    const chats = rows.filter((r) => !r.runPrincipalId)
    const chatUsers = [...new Set(chats.map((r) => r.llmUserId))]
    const names =
      deps.memberNames && chatUsers.length > 0 ? await deps.memberNames(chatUsers) : new Map()
    // A chat run's key is `<agentId>:<chat session id>` (durable engine contract).
    const sessionOf = (row: (typeof rows)[number]) =>
      sessionIdOfConversationKey(row.agentId, row.conversationKey)
    const topics =
      deps.chatTopics && chats.length > 0
        ? await deps.chatTopics(chats.map(sessionOf))
        : new Map<string, string>()
    return rows
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id - a.id)
      .map((row) => ({
        id: row.id,
        conversationKey: row.conversationKey,
        agentId: row.agentId,
        // A member's own name always wins; derived titles are read-time only.
        title:
          row.userTitle ??
          runTitle({
            conversationKey: row.conversationKey,
            background: row.runPrincipalId !== null,
            memberName: names.get(row.llmUserId) ?? null,
            topic: row.runPrincipalId === null ? (topics.get(sessionOf(row)) ?? null) : null,
          }),
        renamable: row.llmUserId === viewerUserId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }))
  }
  return {
    list,
    async rename(viewerUserId, runId, title) {
      const row = (await deps.index.listConversations()).find((r) => r.id === runId)
      if (!row) return { ok: false, status: 404, error: `unknown run ${runId}` }
      if (row.llmUserId !== viewerUserId) {
        return {
          ok: false,
          status: 403,
          error: 'Only the member who had this conversation can rename it.',
        }
      }
      if (!(await deps.index.setUserTitle(runId, title))) {
        return { ok: false, status: 404, error: `unknown run ${runId}` }
      }
      const run = (await list(viewerUserId)).find((r) => r.id === runId)
      if (!run) throw new Error(`run ${runId} vanished right after its rename`)
      return { ok: true, run }
    },
    async watch(runId) {
      const row = (await deps.index.listConversations()).find((r) => r.id === runId)
      if (!row) return null
      const piId = Number(row.piConversationId)
      if (!Number.isSafeInteger(piId)) {
        throw new Error(
          `durable conversation index row ${row.id} carries a non-integer pi conversation id: ${row.piConversationId}`,
        )
      }
      const box = await deps.harness()
      return box.events(piId)
    },
  }
}

/** The same lazy pooled DB handle the durable engine's index uses (durable-engine.ts). */
function defaultIndex(): DurableConversationIndex {
  return new DbDurableConversationIndex(async () => {
    const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
    return appDbAsyncLocal.getStore() ?? createScopedDrizzle(appSql)
  })
}

/** Member display names (name, else email) from the auth user table (company-level, like the members list). */
async function defaultMemberNames(userIds: string[]): Promise<ReadonlyMap<string, string>> {
  const { getDb } = await import('$lib/server/db')
  const { user } = await import('$lib/server/db/auth.schema')
  const { inArray } = await import('drizzle-orm')
  const rows = await getDb()
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(inArray(user.id, userIds))
  // The same display rule as the shell's user menu: the name, else the email.
  return new Map(rows.map((r) => [r.id, r.name.trim() || r.email]))
}

/** Chat session ids are uuids; anything else cannot name a chat_session row. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Each chat session's first member message: what the conversation is about. */
async function defaultChatTopics(sessionIds: string[]): Promise<ReadonlyMap<string, string>> {
  const ids = sessionIds.filter((id) => UUID.test(id))
  if (ids.length === 0) return new Map()
  const { getDb } = await import('$lib/server/db')
  const { chatMessage } = await import('$lib/server/db/brain.schema')
  const { and, asc, eq, inArray } = await import('drizzle-orm')
  // One row per session: its oldest user message.
  const rows = await getDb()
    .selectDistinctOn([chatMessage.sessionId], {
      sessionId: chatMessage.sessionId,
      content: chatMessage.content,
    })
    .from(chatMessage)
    .where(and(inArray(chatMessage.sessionId, ids), eq(chatMessage.role, 'user')))
    .orderBy(chatMessage.sessionId, asc(chatMessage.createdAt))
  return new Map(rows.map((r) => [r.sessionId, r.content]))
}

/**
 * Production source. The harness is the process singleton boot opened (with
 * the engine's full deps); the run view only reads it and never opens one.
 */
export function agentRunsSource(): AgentRunsSource {
  return createAgentRunsSource({
    index: defaultIndex(),
    harness: () => openedDurableHarness(),
    memberNames: defaultMemberNames,
    chatTopics: defaultChatTopics,
  })
}
