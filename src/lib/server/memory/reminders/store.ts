import type { Weekday } from './schedule'

/**
 * Reminders: the store port (live: db-store.ts over migration 0163, under
 * row-level security as the person; tests: memory-store.ts). Every call names
 * the person: a store only ever reads and writes that person's own rows. The
 * rules — what is due, what a change means — live in service.ts.
 */

export type ReminderStatus = 'active' | 'paused'

export type Reminder = {
  id: string
  userId: string
  title: string
  note: string
  weekdays: Weekday[]
  /** HH:MM wall time in timeZone. */
  time: string
  timeZone: string
  status: ReminderStatus
  /** Every occurrence at or before this instant is handled (ticked off, or skipped while paused or rescheduled). */
  handledThrough: Date
  /** Hidden from Needs you until then; null = not snoozed. */
  snoozedUntil: Date | null
  createdVia: 'person' | 'assistant'
  createdAt: Date
  updatedAt: Date
}

export type ReminderPatch = Partial<
  Pick<Reminder, 'title' | 'note' | 'weekdays' | 'time' | 'timeZone' | 'status' | 'handledThrough' | 'snoozedUntil' | 'updatedAt'>
>

export type ReminderStore = {
  insert(reminder: Reminder): Promise<void>
  get(userId: string, id: string): Promise<Reminder | null>
  /** The person's reminders, oldest first. */
  list(userId: string): Promise<Reminder[]>
  /**
   * Applies the patch; with `ifHandledThrough`, only while handledThrough is
   * still that instant (two ticks at once advance it exactly once). Null when
   * the reminder is gone or the guard did not hold.
   */
  update(userId: string, id: string, patch: ReminderPatch, guard?: { ifHandledThrough: Date }): Promise<Reminder | null>
  /** False when there was no such reminder. */
  delete(userId: string, id: string): Promise<boolean>
}
