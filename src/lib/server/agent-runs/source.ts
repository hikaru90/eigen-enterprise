import type { RunSummary } from '$lib/agent-runs/feed'
import {
  DbDurableConversationIndex,
  type DurableConversationIndex,
} from '$lib/server/agent/conversation-index'
import { getDurableHarness, type DurableHarnessBox } from '$lib/server/agent/durable-harness'
import type { AgentEventStream } from '$lib/server/agent/pi-durable'

/**
 * The D8 run view's read port over the durable agent: the run list comes from
 * the Postgres conversation index (D7), one run's live events from the
 * process harness (`DurableHarnessBox.events`). Narrow adapter over the
 * existing exports of src/lib/server/agent/* — it never writes.
 */
export type AgentRunsSource = {
  list(): Promise<RunSummary[]>
  /** The run's live event stream, or null when the index has no such run. */
  watch(runId: number): Promise<AgentEventStream | null>
}

export function createAgentRunsSource(deps: {
  index: DurableConversationIndex
  harness: () => Promise<Pick<DurableHarnessBox, 'events'>>
}): AgentRunsSource {
  return {
    async list() {
      const rows = await deps.index.listConversations()
      return rows
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id - a.id)
        .map((row) => ({
          id: row.id,
          conversationKey: row.conversationKey,
          agentId: row.agentId,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }))
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

/**
 * Production source. The harness is a process singleton: boot normally opened
 * it already (getDurableHarness returns the cached box); otherwise this opens
 * it with the same deps the engine uses (process env + the Postgres index).
 */
export function agentRunsSource(): AgentRunsSource {
  const index = defaultIndex()
  return createAgentRunsSource({
    index,
    harness: () => getDurableHarness({ env: process.env, index }),
  })
}
