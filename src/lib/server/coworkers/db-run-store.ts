import type { CoworkerRunPatch, CoworkerRunRow, CoworkerRunStore, NewCoworkerRun, ThreadRuns } from './run-store'
import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { coworkerRun, coworkerRunNotice } from '$lib/server/db/coworkers.schema'

/**
 * coworker_run in Postgres (migration 0171). A company-level table without
 * RLS: it runs on the app pool's own connection (never inside a member's RLS
 * session). Claims on one thread hold a transaction-scoped advisory lock on
 * the thread, so every app process decides one thread's next turn in turn.
 */

/** pg_advisory_xact_lock(namespace, hashtext(thread)) — 'cowr' as an int4. */
export const COWORKER_THREAD_LOCK_NAMESPACE = 0x636f7772
/** pg_advisory_xact_lock(namespace, hashtext(task id)) — 'cowt' as an int4: a task's runs are claimed one at a time. */
export const COWORKER_TASK_LOCK_NAMESPACE = 0x636f7774

type Db = Pick<AppDatabase, 'select' | 'insert' | 'update' | 'execute'>

export const rowOfRun = (r: typeof coworkerRun.$inferSelect): CoworkerRunRow => ({
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
  rhythmId: r.rhythmId,
  taskId: r.taskId,
  triggerKey: r.triggerKey,
  delegationChain: r.delegationChain,
})

const INTERRUPTED = 'the turn stopped beating: its server process ended during the turn'

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
      // Two unique indexes (trigger message, trigger key): any conflict means another process queued it.
      const [row] = await (await db()).insert(coworkerRun).values({ ...run, status: 'queued' }).onConflictDoNothing().returning()
      return row ? rowOfRun(row) : null
    },

    async get(id) {
      const [row] = await (await db()).select().from(coworkerRun).where(eq(coworkerRun.id, id)).limit(1)
      return row ? rowOfRun(row) : null
    },

    async claimWork(id, now) {
      return (await db()).transaction(async (tx) => {
        const [row] = await tx.select().from(coworkerRun).where(eq(coworkerRun.id, id)).limit(1)
        if (!row || row.status !== 'queued') return null
        if (row.taskId) {
          await tx.execute(sql`select pg_advisory_xact_lock(${COWORKER_TASK_LOCK_NAMESPACE}::int4, hashtext(${row.taskId}))`)
          const busy = await tx
            .select({ id: coworkerRun.id })
            .from(coworkerRun)
            .where(and(eq(coworkerRun.taskId, row.taskId), eq(coworkerRun.status, 'running'), ne(coworkerRun.id, id)))
            .limit(1)
          if (busy.length > 0) return null
        }
        const [claimed] = await tx
          .update(coworkerRun)
          .set({ status: 'running', startedAt: now, heartbeatAt: now })
          .where(and(eq(coworkerRun.id, id), eq(coworkerRun.status, 'queued')))
          .returning()
        return claimed ? rowOfRun(claimed) : null
      })
    },

    async interruptIfStale(id, staleBefore, now) {
      const [row] = await (await db())
        .update(coworkerRun)
        .set({ status: 'failed', stopReason: 'interrupted', endedAt: now, error: INTERRUPTED })
        .where(
          and(
            eq(coworkerRun.id, id),
            eq(coworkerRun.status, 'running'),
            lt(sql`coalesce(${coworkerRun.heartbeatAt}, ${coworkerRun.startedAt}, ${coworkerRun.triggeredAt})`, staleBefore),
          ),
        )
        .returning()
      return row ? rowOfRun(row) : null
    },

    async addNotices(runId, userIds, at) {
      const ids = [...new Set(userIds)]
      if (ids.length === 0) return
      await (await db())
        .insert(coworkerRunNotice)
        .values(ids.map((userId) => ({ runId, userId, createdAt: at })))
        .onConflictDoNothing()
    },

    async openNotices(userId) {
      const rows = await (await db())
        .select({ run: coworkerRun, createdAt: coworkerRunNotice.createdAt })
        .from(coworkerRunNotice)
        .innerJoin(coworkerRun, eq(coworkerRun.id, coworkerRunNotice.runId))
        .where(and(eq(coworkerRunNotice.userId, userId), isNull(coworkerRunNotice.seenAt)))
        .orderBy(desc(coworkerRunNotice.createdAt))
      return rows.map((r) => ({ run: rowOfRun(r.run), userId, createdAt: r.createdAt }))
    },

    async markNoticeSeen(runId, userId, at) {
      const rows = await (await db())
        .update(coworkerRunNotice)
        .set({ seenAt: sql`coalesce(${coworkerRunNotice.seenAt}, ${at.toISOString()}::timestamptz)` })
        .where(and(eq(coworkerRunNotice.runId, runId), eq(coworkerRunNotice.userId, userId)))
        .returning({ runId: coworkerRunNotice.runId })
      return rows.length === 1
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
            return rows.map(rowOfRun)
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
      return rows.map(rowOfRun)
    },

    async listUnfinished() {
      const rows = await (await db()).select().from(coworkerRun).where(inArray(coworkerRun.status, ['queued', 'running']))
      return rows.map(rowOfRun)
    },
    async runningChains(coworkerUserId: string) {
      const rows = await (await db())
        .select({ chain: coworkerRun.delegationChain })
        .from(coworkerRun)
        .where(and(eq(coworkerRun.coworkerUserId, coworkerUserId), eq(coworkerRun.status, 'running')))
      return rows.map((r) => r.chain)
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
