import type { EventObservationRow, EventObservationStore, EventRouteRow, EventSubscriptionStore } from './events'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { coworkerEventObservation, coworkerEventRoute, coworkerEventSubscription } from '$lib/server/db/coworker-events.schema'
import { zeroCounts } from './events'

/**
 * coworker_event_subscription, coworker_event_route and coworker_event_observation in Postgres
 * (migrations 0176, 0177). Company-level tables without RLS: the app pool's own connection
 * (never a member's RLS session). A route claim is one transaction: the unique index on
 * (kind, event id) makes every route insert but the first a no-op — so an event is routed once
 * across every app process — and the winner inserts one observation per candidate co-worker
 * (a row from before routing, unique per co-worker and event, is kept as it was).
 */

const rowOf = (r: typeof coworkerEventObservation.$inferSelect): EventObservationRow => ({ ...r })
const routeOf = (r: typeof coworkerEventRoute.$inferSelect): EventRouteRow => ({ ...r })

export function dbCoworkerEventStores(db: () => Promise<AppDatabase>): EventObservationStore & EventSubscriptionStore {
  return {
    async claimRoute(input) {
      if (input.coworkerUserIds.length === 0) throw new Error('an event is routed only when some co-worker could be its')
      return (await db()).transaction(async (tx) => {
        const [route] = await tx
          .insert(coworkerEventRoute)
          .values({
            eventKind: input.eventKind,
            eventId: input.eventId,
            conversationId: input.conversationId,
            authorUserId: input.authorUserId,
            outcome: 'claimed',
            candidates: input.coworkerUserIds.length,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoNothing()
          .returning()
        if (!route) return null
        const made = await tx
          .insert(coworkerEventObservation)
          .values(
            input.coworkerUserIds.map((coworkerUserId) => ({
              coworkerUserId,
              eventKind: input.eventKind,
              eventId: input.eventId,
              conversationId: input.conversationId,
              outcome: 'claimed' as const,
              routeId: route.id,
              createdAt: input.now,
              updatedAt: input.now,
            })),
          )
          .onConflictDoNothing()
          .returning()
        const order = new Map(input.coworkerUserIds.map((id, n) => [id, n]))
        return { route: routeOf(route), observations: made.map(rowOf).sort((a, b) => order.get(a.coworkerUserId)! - order.get(b.coworkerUserId)!) }
      })
    },

    async finishRoute(id, patch, at) {
      const rows = await (await db())
        .update(coworkerEventRoute)
        .set({ ...patch, updatedAt: at })
        .where(eq(coworkerEventRoute.id, id))
        .returning({ id: coworkerEventRoute.id })
      if (rows.length !== 1) throw new Error(`updating coworker event route ${id} matched ${rows.length} rows`)
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

    async subscribers(kind) {
      const rows = await (await db())
        .select({ id: coworkerEventSubscription.coworkerUserId })
        .from(coworkerEventSubscription)
        .where(eq(coworkerEventSubscription.eventKind, kind))
        .orderBy(coworkerEventSubscription.coworkerUserId)
      return rows.map((r) => r.id)
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
