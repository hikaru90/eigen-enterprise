import type { CoworkerRunPatch, CoworkerRunRow, CoworkerRunStore, NewCoworkerRun, ThreadRuns } from './run-store'
import { and, desc, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { coworkerRun } from '$lib/server/db/coworkers.schema'

/**
 * coworker_run in Postgres (migration 0171). A company-level table without
 * RLS: it runs on the app pool's own connection (never inside a member's RLS
 * session). Claims on one thread hold a transaction-scoped advisory lock on
 * the thread, so every app process decides one thread's next turn in turn.
 */

/** pg_advisory_xact_lock(namespace, hashtext(thread)) — 'cowr' as an int4. */
export const COWORKER_THREAD_LOCK_NAMESPACE = 0x636f7772

type Db = Pick<AppDatabase, 'select' | 'insert' | 'update' | 'execute'>

const rowOf = (r: typeof coworkerRun.$inferSelect): CoworkerRunRow => ({
  id: r.id,
  coworkerUserId: r.coworkerUserId,
  triggerKind: r.triggerKind,
  conversationId: r.conversationId,
  threadRootId: r.threadRootId,
  triggerMessageId: r.triggerMessageId,
  requestedByUserId: r.requestedByUserId,
  status: r.status,
  stopReason: r.stopReason,
  costUsd: Number(r.costUsd),
  triggeredAt: r.triggeredAt,
  startedAt: r.startedAt,
  heartbeatAt: r.heartbeatAt,
  endedAt: r.endedAt,
  error: r.error,
})

function setOf(patch: CoworkerRunPatch): Partial<typeof coworkerRun.$inferInsert> {
  const { costUsd, ...rest } = patch
  return { ...rest, ...(costUsd === undefined ? {} : { costUsd: costUsd.toFixed(6) }) }
}

async function updateRun(db: Db, id: string, patch: CoworkerRunPatch): Promise<void> {
  const rows = await db.update(coworkerRun).set(setOf(patch)).where(eq(coworkerRun.id, id)).returning({ id: coworkerRun.id })
  if (rows.length !== 1) throw new Error(`updating coworker run ${id} matched ${rows.length} rows`)
}

const threadIs = (conversationId: string, threadRootId: string | null): SQL =>
  and(
    eq(coworkerRun.conversationId, conversationId),
    threadRootId === null ? isNull(coworkerRun.threadRootId) : eq(coworkerRun.threadRootId, threadRootId),
  )!

export function dbCoworkerRunStore(db: () => Promise<AppDatabase>): CoworkerRunStore {
  return {
    async enqueue(run: NewCoworkerRun) {
      const [row] = await (await db())
        .insert(coworkerRun)
        .values({ ...run, status: 'queued' })
        .onConflictDoNothing({ target: [coworkerRun.coworkerUserId, coworkerRun.triggerMessageId] })
        .returning()
      return row ? rowOf(row) : null
    },

    async withThread(key, fn) {
      return (await db()).transaction(async (tx) => {
        const name = `${key.conversationId}:${key.threadRootId ?? 'main'}`
        await tx.execute(sql`select pg_advisory_xact_lock(${COWORKER_THREAD_LOCK_NAMESPACE}::int4, hashtext(${name}))`)
        const runs: ThreadRuns = {
          async relevant(since) {
            const rows = await tx
              .select()
              .from(coworkerRun)
              .where(
                and(
                  threadIs(key.conversationId, key.threadRootId),
                  since === null ? undefined : or(inArray(coworkerRun.status, ['queued', 'running']), gte(coworkerRun.triggeredAt, since)),
                ),
              )
            return rows.map(rowOf)
          },
          update: (id, patch) => updateRun(tx, id, patch),
        }
        return fn(runs)
      })
    },

    async update(id, patch) {
      await updateRun(await db(), id, patch)
    },

    async listForCoworker(coworkerUserId, limit) {
      const rows = await (await db())
        .select()
        .from(coworkerRun)
        .where(eq(coworkerRun.coworkerUserId, coworkerUserId))
        .orderBy(desc(coworkerRun.triggeredAt), desc(coworkerRun.id))
        .limit(limit)
      return rows.map(rowOf)
    },

    async listUnfinished() {
      const rows = await (await db()).select().from(coworkerRun).where(inArray(coworkerRun.status, ['queued', 'running']))
      return rows.map(rowOf)
    },
  }
}

/** The app pool's own connection (company-level table: never a member's RLS session). */
let pooled: AppDatabase | null = null
export const liveCoworkerRunStore = dbCoworkerRunStore(async () => {
  if (pooled) return pooled
  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  pooled = createScopedDrizzle(appSql)
  return pooled
})
