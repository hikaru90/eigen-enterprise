import type { ProposalRow, ProposalStore } from './proposal-store'
import { and, asc, eq } from 'drizzle-orm'
import { calendarProposals } from '$lib/server/db/calendar.schema'
import type { AppDatabase } from '$lib/server/db/context'

/** ProposalStore over Postgres (company-level table, migration 0140). */
export function dbProposalStore(db: AppDatabase): ProposalStore {
  return {
    async insert(row: ProposalRow) {
      const out = await db
        .insert(calendarProposals)
        .values(row)
        .onConflictDoNothing({ target: calendarProposals.messageId })
        .returning({ id: calendarProposals.id })
      return out.length > 0
    },
    async get(id) {
      const [r] = await db.select().from(calendarProposals).where(eq(calendarProposals.id, id)).limit(1)
      return r ?? null
    },
    async forMessage(messageId) {
      const [r] = await db.select().from(calendarProposals).where(eq(calendarProposals.messageId, messageId)).limit(1)
      return r ?? null
    },
    async open(memberId) {
      return db
        .select()
        .from(calendarProposals)
        .where(and(eq(calendarProposals.memberId, memberId), eq(calendarProposals.state, 'open')))
        .orderBy(asc(calendarProposals.startsAt), asc(calendarProposals.createdAt))
    },
    async decide(id, state, at) {
      const out = await db
        .update(calendarProposals)
        .set({ state, decidedAt: at })
        .where(and(eq(calendarProposals.id, id), eq(calendarProposals.state, 'open')))
        .returning({ id: calendarProposals.id })
      return out.length > 0
    },
    async reopen(id) {
      const out = await db
        .update(calendarProposals)
        .set({ state: 'open', decidedAt: null, eventId: null })
        .where(eq(calendarProposals.id, id))
        .returning({ id: calendarProposals.id })
      if (out.length === 0) throw new Error(`calendar proposal ${id} not found`)
    },
    async setEvent(id, eventId) {
      const out = await db.update(calendarProposals).set({ eventId }).where(eq(calendarProposals.id, id)).returning({ id: calendarProposals.id })
      if (out.length === 0) throw new Error(`calendar proposal ${id} not found`)
    },
  }
}
