import type { EventObservationRow, EventObservationStore, EventSubscriptionStore } from './events'
import { and, eq, gt, gte, inArray, sql } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { coworkerEventObservation, coworkerEventSubscription } from '$lib/server/db/coworker-events.schema'
import { COUNTED_OUTCOMES, zeroCounts } from './events'

/**
 * coworker_event_subscription and coworker_event_observation in Postgres (migration 0176).
 * Company-level tables without RLS: the app pool's own connection (never a member's RLS
 * session). A claim holds a transaction-scoped advisory lock on the co-worker, so the
 * hourly count and the insert are one step across every app process; the unique index on
 * (co-worker, kind, event id) makes every insert but the first a no-op.
 */

/** pg_advisory_xact_lock(namespace, hashtext(co-worker id)) — 'cwev' as an int4. */
export const COWORKER_EVENT_LOCK_NAMESPACE = 0x63776576

const HOUR_MS = 3_600_000

const rowOf = (r: typeof coworkerEventObservation.$inferSelect): EventObservationRow => ({ ...r })

export function dbCoworkerEventStores(db: () => Promise<AppDatabase>): EventObservationStore & EventSubscriptionStore {
  return {
    async claim(input) {
      return (await db()).transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${COWORKER_EVENT_LOCK_NAMESPACE}::int4, hashtext(${input.coworkerUserId}))`)
        const since = new Date(input.now.getTime() - HOUR_MS)
        const [{ used }] = (await tx
          .select({ used: sql<number>`count(*)::int` })
          .from(coworkerEventObservation)
          .where(
            and(
              eq(coworkerEventObservation.coworkerUserId, input.coworkerUserId),
              inArray(coworkerEventObservation.outcome, [...COUNTED_OUTCOMES]),
              gt(coworkerEventObservation.createdAt, since),
            ),
          )) as [{ used: number }]
        const over = used >= input.hourlyLimit
        const [row] = await tx
          .insert(coworkerEventObservation)
          .values({
            coworkerUserId: input.coworkerUserId,
            eventKind: input.eventKind,
            eventId: input.eventId,
            conversationId: input.conversationId,
            outcome: over ? 'skipped_rate_limit' : 'claimed',
            error: over ? `over ${input.hourlyLimit} event decisions in the last hour` : null,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoNothing()
          .returning()
        return row ? rowOf(row) : null
      })
    },

    async finish(id, patch, at) {
      const rows = await (await db())
        .update(coworkerEventObservation)
        .set({ ...patch, updatedAt: at })
        .where(eq(coworkerEventObservation.id, id))
        .returning({ id: coworkerEventObservation.id })
      if (rows.length !== 1) throw new Error(`updating coworker event observation ${id} matched ${rows.length} rows`)
    },

    async counts(coworkerUserId, since) {
      const rows = await (await db())
        .select({ outcome: coworkerEventObservation.outcome, n: sql<number>`count(*)::int` })
        .from(coworkerEventObservation)
        .where(and(eq(coworkerEventObservation.coworkerUserId, coworkerUserId), gte(coworkerEventObservation.createdAt, since)))
        .groupBy(coworkerEventObservation.outcome)
      const out = zeroCounts()
      for (const r of rows) out[r.outcome] = Number(r.n)
      return out
    },

    async list(coworkerUserId) {
      const rows = await (await db())
        .select({ kind: coworkerEventSubscription.eventKind })
        .from(coworkerEventSubscription)
        .where(eq(coworkerEventSubscription.coworkerUserId, coworkerUserId))
        .orderBy(coworkerEventSubscription.eventKind)
      return rows.map((r) => r.kind)
    },

    async set(coworkerUserId, kinds, by, at) {
      const wanted = [...new Set(kinds)]
      await (await db()).transaction(async (tx) => {
        await tx.delete(coworkerEventSubscription).where(eq(coworkerEventSubscription.coworkerUserId, coworkerUserId))
        if (wanted.length > 0) {
          await tx.insert(coworkerEventSubscription).values(wanted.map((eventKind) => ({ coworkerUserId, eventKind, createdBy: by, createdAt: at })))
        }
      })
    },
  }
}

/** The app pool's own connection (company-level tables). */
let pooled: AppDatabase | null = null
export const liveCoworkerEventStores = dbCoworkerEventStores(async () => {
  if (pooled) return pooled
  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  pooled = createScopedDrizzle(appSql)
  return pooled
})
