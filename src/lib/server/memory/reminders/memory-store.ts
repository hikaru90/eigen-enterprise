import type { Reminder, ReminderStore } from './store'

/** In-memory ReminderStore for tests: the same contract as the Postgres store (rows only reach their owner). */
export function memoryReminderStore(): ReminderStore & { reminders: Map<string, Reminder> } {
  const reminders = new Map<string, Reminder>()
  const copy = (r: Reminder): Reminder => ({ ...r, weekdays: [...r.weekdays] })
  const own = (userId: string, id: string) => {
    const r = reminders.get(id)
    return r && r.userId === userId ? r : null
  }
  return {
    reminders,
    async insert(reminder) {
      if (reminders.has(reminder.id)) throw new Error(`reminder ${reminder.id} exists`)
      reminders.set(reminder.id, copy(reminder))
    },
    async get(userId, id) {
      const r = own(userId, id)
      return r ? copy(r) : null
    },
    async list(userId) {
      return [...reminders.values()]
        .filter((r) => r.userId === userId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(copy)
    },
    async update(userId, id, patch, guard) {
      const r = own(userId, id)
      if (!r) return null
      if (guard && r.handledThrough.getTime() !== guard.ifHandledThrough.getTime()) return null
      Object.assign(r, patch)
      if (patch.weekdays) r.weekdays = [...patch.weekdays]
      return copy(r)
    },
    async delete(userId, id) {
      if (!own(userId, id)) return false
      reminders.delete(id)
      return true
    },
  }
}
