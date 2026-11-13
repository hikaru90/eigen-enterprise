import type { AttendeeRow, CalendarStore, EventRow } from './store'
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { calendarAttendees, calendarEvents, calendarPreferences } from '$lib/server/db/calendar.schema'
import type { AppDatabase } from '$lib/server/db/context'

/** CalendarStore over Postgres (company-level tables, migration 0138). */

type Selected = typeof calendarEvents.$inferSelect

/** postgres-js hands timestamptz[] back as strings in some paths: normalise to Dates (fail loud on garbage). */
function toDates(id: string, values: unknown): Date[] {
  if (!Array.isArray(values)) throw new Error(`calendar event ${id} has malformed exdates`)
  return values.map((v) => {
    const d = v instanceof Date ? v : new Date(String(v))
    if (Number.isNaN(d.getTime())) throw new Error(`calendar event ${id} has a malformed exdate ${JSON.stringify(v)}`)
    return d
  })
}

const toRow = (r: Selected): EventRow => ({ ...r, exdates: toDates(r.id, r.exdates) })

/** Events (by id) where one of the members is a member guest. */
const guestOf = (memberIds: readonly string[]) =>
  sql`select ${calendarAttendees.eventId} from ${calendarAttendees} where ${inArray(calendarAttendees.memberId, [...memberIds])}`

export function dbCalendarStore(db: AppDatabase): CalendarStore {
  return {
    async insertEvent(row, attendees) {
      await db.transaction(async (tx) => {
        await tx.insert(calendarEvents).values(row)
        if (attendees.length > 0) await tx.insert(calendarAttendees).values(attendees)
      })
    },
    async getEvent(id) {
      const [r] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).limit(1)
      return r ? toRow(r) : null
    },
    async updateEvent(id, patch) {
      const out = await db.update(calendarEvents).set(patch).where(eq(calendarEvents.id, id)).returning({ id: calendarEvents.id })
      if (out.length === 0) throw new Error(`calendar event ${id} not found`)
    },
    async deleteEvent(id) {
      await db.delete(calendarEvents).where(eq(calendarEvents.id, id))
    },
    async replaceAttendees(eventId, rows) {
      await db.transaction(async (tx) => {
        await tx.delete(calendarAttendees).where(eq(calendarAttendees.eventId, eventId))
        if (rows.length > 0) await tx.insert(calendarAttendees).values(rows)
      })
    },
    async attendees(eventIds) {
      if (eventIds.length === 0) return []
      return (await db
        .select()
        .from(calendarAttendees)
        .where(inArray(calendarAttendees.eventId, [...eventIds]))
        .orderBy(asc(calendarAttendees.createdAt), asc(calendarAttendees.id))) as AttendeeRow[]
    },
    async overrides(seriesId) {
      const rows = await db.select().from(calendarEvents).where(eq(calendarEvents.recurrenceId, seriesId)).orderBy(asc(calendarEvents.originalStart))
      return rows.map(toRow)
    },
    async inRange(memberIds, from, to) {
      if (memberIds.length === 0) return []
      const ids = [...memberIds]
      const mine = (key: typeof calendarEvents.id | typeof calendarEvents.recurrenceId) =>
        or(inArray(calendarEvents.ownerId, ids), sql`${key} in (${guestOf(ids)})`)
      const overlaps = and(lt(calendarEvents.startsAt, to), gt(calendarEvents.endsAt, from))
      const tops = await db
        .select()
        .from(calendarEvents)
        .where(
          and(
            isNull(calendarEvents.recurrenceId),
            mine(calendarEvents.id),
            or(
              and(isNull(calendarEvents.rrule), overlaps),
              and(
                isNotNull(calendarEvents.rrule),
                lt(calendarEvents.startsAt, to),
                or(isNull(calendarEvents.recurrenceEndsAt), gt(calendarEvents.recurrenceEndsAt, from)),
              ),
            ),
          ),
        )
      const seriesIds = tops.filter((r) => r.rrule !== null).map((r) => r.id)
      const changed = await db
        .select()
        .from(calendarEvents)
        .where(
          and(
            isNotNull(calendarEvents.recurrenceId),
            or(
              and(mine(calendarEvents.recurrenceId), overlaps),
              seriesIds.length > 0 ? inArray(calendarEvents.recurrenceId, seriesIds) : sql`false`,
            ),
          ),
        )
      return [...tops, ...changed]
        .map(toRow)
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id))
    },
    async defaultVisibility(memberId) {
      const [r] = await db
        .select({ v: calendarPreferences.defaultVisibility })
        .from(calendarPreferences)
        .where(eq(calendarPreferences.memberId, memberId))
        .limit(1)
      return r?.v ?? null
    },
    async setDefaultVisibility(memberId, visibility, at) {
      await db
        .insert(calendarPreferences)
        .values({ memberId, defaultVisibility: visibility, updatedAt: at })
        .onConflictDoUpdate({ target: calendarPreferences.memberId, set: { defaultVisibility: visibility, updatedAt: at } })
    },
  }
}
