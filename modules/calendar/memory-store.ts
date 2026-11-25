import type { AttendeeRow, CalendarStore, EventRow, ReminderKey } from './store'
import type { Visibility } from './types'

/** In-memory CalendarStore for unit tests (same semantics as the DB store). */
export function memoryCalendarStore(): CalendarStore & {
  events: Map<string, EventRow>
  guests: Map<string, AttendeeRow>
  claimed: Map<string, ReminderKey>
} {
  const events = new Map<string, EventRow>()
  const guests = new Map<string, AttendeeRow>()
  const prefs = new Map<string, Visibility>()
  const weekNumbers = new Map<string, boolean>()
  const reminderLeads = new Map<string, number | null>()
  const claimed = new Map<string, ReminderKey>()
  const claimKey = (k: ReminderKey) => `${k.eventId}|${k.occurrenceStart.getTime()}|${k.memberId}`
  const copy = (r: EventRow): EventRow => ({ ...r, exdates: r.exdates.map((d) => new Date(d)) })
  const t = (d: Date) => d.getTime()

  const guestsOf = (eventId: string) => [...guests.values()].filter((g) => g.eventId === eventId)
  const relevant = (r: EventRow, ids: Set<string>) =>
    ids.has(r.ownerId) || guestsOf(r.recurrenceId ?? r.id).some((g) => g.memberId !== null && ids.has(g.memberId))
  const overlaps = (r: EventRow, from: Date, to: Date) => t(r.startsAt) < t(to) && t(r.endsAt) > t(from)

  return {
    events,
    guests,
    claimed,
    async insertEvent(row, attendees) {
      if (events.has(row.id)) throw new Error(`event ${row.id} exists`)
      if (row.recurrenceId) {
        for (const e of events.values()) {
          if (e.recurrenceId === row.recurrenceId && t(e.originalStart!) === t(row.originalStart!)) throw new Error('override exists')
        }
      }
      events.set(row.id, copy(row))
      for (const a of attendees) guests.set(a.id, { ...a })
    },
    async getEvent(id) {
      const r = events.get(id)
      return r ? copy(r) : null
    },
    async updateEvent(id, patch) {
      const r = events.get(id)
      if (!r) throw new Error(`event ${id} not found`)
      events.set(id, copy({ ...r, ...patch }))
    },
    async deleteEvent(id) {
      for (const e of [...events.values()]) if (e.recurrenceId === id) events.delete(e.id)
      events.delete(id)
      for (const g of [...guests.values()]) if (!events.has(g.eventId)) guests.delete(g.id)
      for (const [k, c] of [...claimed]) if (!events.has(c.eventId)) claimed.delete(k)
    },
    async replaceAttendees(eventId, rows) {
      for (const g of guestsOf(eventId)) guests.delete(g.id)
      for (const a of rows) guests.set(a.id, { ...a })
    },
    async attendees(eventIds) {
      const ids = new Set(eventIds)
      return [...guests.values()].filter((g) => ids.has(g.eventId)).map((g) => ({ ...g }))
    },
    async overrides(seriesId) {
      return [...events.values()].filter((e) => e.recurrenceId === seriesId).map(copy)
    },
    async inRange(memberIds, from, to) {
      const ids = new Set(memberIds)
      const out = new Map<string, EventRow>()
      for (const r of events.values()) {
        if (r.recurrenceId !== null || !relevant(r, ids)) continue
        const hit = r.rrule === null ? overlaps(r, from, to) : t(r.startsAt) < t(to) && (r.recurrenceEndsAt === null || t(r.recurrenceEndsAt) > t(from))
        if (hit) out.set(r.id, r)
      }
      for (const r of events.values()) {
        if (r.recurrenceId === null) continue
        if (out.has(r.recurrenceId) || (relevant(r, ids) && overlaps(r, from, to))) out.set(r.id, r)
      }
      return [...out.values()].sort((a, b) => t(a.startsAt) - t(b.startsAt) || a.id.localeCompare(b.id)).map(copy)
    },
    async defaultVisibility(memberId) {
      return prefs.get(memberId) ?? null
    },
    async setDefaultVisibility(memberId, visibility) {
      prefs.set(memberId, visibility)
    },
    async weekNumbers(memberId) {
      return weekNumbers.get(memberId) ?? null
    },
    async setWeekNumbers(memberId, on) {
      weekNumbers.set(memberId, on)
    },
    async reminderMinutes(memberIds) {
      return new Map(memberIds.filter((id) => reminderLeads.has(id)).map((id) => [id, reminderLeads.get(id)!]))
    },
    async setReminderMinutes(memberId, minutes) {
      reminderLeads.set(memberId, minutes)
    },
    async claimReminder(key) {
      if (!events.has(key.eventId)) throw new Error(`event ${key.eventId} not found`)
      if (claimed.has(claimKey(key))) return false
      claimed.set(claimKey(key), { ...key })
      return true
    },
    async releaseReminder(key) {
      claimed.delete(claimKey(key))
    },
    async pruneReminders(before) {
      let n = 0
      for (const [k, v] of [...claimed]) {
        if (t(v.occurrenceStart) >= t(before)) continue
        claimed.delete(k)
        n++
      }
      return n
    },
  }
}
