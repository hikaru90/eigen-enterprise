import type { RhythmPatch, RhythmRow, RhythmStore } from './rhythms'
import { and, asc, eq } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { coworkerRhythm, coworkerRun } from '$lib/server/db/coworkers.schema'
import type { Weekday } from '$lib/server/memory/reminders/schedule'
import { rowOfRun } from './db-run-store'

/**
 * coworker_rhythm in Postgres (migration 0173). A company-level table without
 * RLS, on the app pool's own connection like coworker_run. takeSlot moves
 * last_slot_at with a compare-and-set and inserts the slot's run in the same
 * transaction: one app process wins a slot, the others' updates match nothing.
 */

const rowOf = (r: typeof coworkerRhythm.$inferSelect): RhythmRow => ({
  id: r.id,
  coworkerUserId: r.coworkerUserId,
  weekdays: r.weekdays as Weekday[],
  time: r.localTime,
  timeZone: r.timeZone,
  instruction: r.instruction,
  targetConversationId: r.targetConversationId,
  enabled: r.enabled,
  lastSlotAt: r.lastSlotAt,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
})

function setOf(patch: RhythmPatch): Partial<typeof coworkerRhythm.$inferInsert> {
  const { time, ...rest } = patch
  return { ...rest, ...(time === undefined ? {} : { localTime: time }) }
}

export function dbRhythmStore(db: () => Promise<AppDatabase>): RhythmStore {
  return {
    async list(coworkerUserId) {
      const rows = await (await db())
        .select()
        .from(coworkerRhythm)
        .where(coworkerUserId === undefined ? undefined : eq(coworkerRhythm.coworkerUserId, coworkerUserId))
        .orderBy(asc(coworkerRhythm.createdAt), asc(coworkerRhythm.id))
      return rows.map(rowOf)
    },

    async get(id) {
      const [row] = await (await db()).select().from(coworkerRhythm).where(eq(coworkerRhythm.id, id)).limit(1)
      return row ? rowOf(row) : null
    },

    async insert(row) {
      await (await db()).insert(coworkerRhythm).values({
        id: row.id,
        coworkerUserId: row.coworkerUserId,
        weekdays: row.weekdays,
        localTime: row.time,
        timeZone: row.timeZone,
        instruction: row.instruction,
        targetConversationId: row.targetConversationId,
        enabled: row.enabled,
        lastSlotAt: row.lastSlotAt,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
    },

    async update(id, patch) {
      const [row] = await (await db()).update(coworkerRhythm).set(setOf(patch)).where(eq(coworkerRhythm.id, id)).returning()
      if (!row) throw new Error(`updating rhythm ${id} matched no row`)
      return rowOf(row)
    },

    async delete(id) {
      const rows = await (await db()).delete(coworkerRhythm).where(eq(coworkerRhythm.id, id)).returning({ id: coworkerRhythm.id })
      return rows.length === 1
    },

    async takeSlot(id, from, to, run) {
      return (await db()).transaction(async (tx) => {
        const moved = await tx
          .update(coworkerRhythm)
          .set({ lastSlotAt: to })
          .where(and(eq(coworkerRhythm.id, id), eq(coworkerRhythm.lastSlotAt, from)))
          .returning({ id: coworkerRhythm.id })
        if (moved.length !== 1) return { won: false, run: null }
        if (!run) return { won: true, run: null }
        const [row] = await tx.insert(coworkerRun).values({ ...run, status: 'queued' }).onConflictDoNothing().returning()
        if (!row) return { won: true, run: null }
        return { won: true, run: rowOfRun(row) }
      })
    },
  }
}

let pooled: AppDatabase | null = null
export const liveRhythmStore = dbRhythmStore(async () => {
  if (pooled) return pooled
  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  pooled = createScopedDrizzle(appSql)
  return pooled
})
