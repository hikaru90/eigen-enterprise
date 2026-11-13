import type { Channel } from './types'

/** A stored contact (the row). Dates are `YYYY-MM-DD` days. */
export type ContactRow = {
  id: string
  name: string
  organisation: string | null
  title: string | null
  channels: Channel[]
  metHow: string | null
  whyRelevant: string | null
  tags: string[]
  lastContactedOn: string | null
  nextFollowUpOn: string | null
  nextStep: string | null
  /** A person's user id, or the agent's principal id when no person was behind it. */
  createdBy: string
  createdByKind: 'user' | 'agent'
  shared: boolean
  createdAt: Date
  updatedAt: Date
}

export type ContactPatch = Partial<
  Pick<
    ContactRow,
    'name' | 'organisation' | 'title' | 'channels' | 'metHow' | 'whyRelevant' | 'tags' | 'lastContactedOn' | 'nextFollowUpOn' | 'nextStep' | 'shared'
  >
> & { updatedAt: Date }

/** One "Log a contact" (migration 0138): the day, how it went, the follow-up it answered and the one it set. */
export type LogEntryRow = {
  id: string
  contactId: string
  on: string
  note: string | null
  answeredFollowUpOn: string | null
  answeredStep: string | null
  nextFollowUpOn: string | null
  nextStep: string | null
  /** A person's user id, or the agent's principal id. */
  loggedBy: string
  loggedByKind: 'user' | 'agent'
  createdAt: Date
}

/**
 * Which contacts a query may return: every one (the owner, admins, the agent
 * on its own) or one person's own plus the shared ones.
 */
export type ContactScope = { kind: 'all' } | { kind: 'person'; userId: string }

/** A list filter: one tag (exact, normalised) and/or a name/organisation search. */
export type ContactFilter = { tag?: string; query?: string }

/** Persistence seam: the DB store in production, the in-memory one in unit tests. */
export type ContactsStore = {
  insert(row: ContactRow): Promise<void>
  /** Inserts every row or none (an import). */
  insertMany(rows: ContactRow[]): Promise<void>
  get(id: string): Promise<ContactRow | null>
  /** Contacts in scope matching the filter, by name (case-insensitive). */
  list(scope: ContactScope, filter: ContactFilter): Promise<ContactRow[]>
  /** Every tag used by a contact in scope, sorted. */
  tags(scope: ContactScope): Promise<string[]>
  /** Contacts in scope with a follow-up on or before `until` (a day), soonest first. */
  followUps(scope: ContactScope, until: string): Promise<ContactRow[]>
  update(id: string, patch: ContactPatch): Promise<void>
  delete(id: string): Promise<void>
  /** Keeps a log entry and applies the contact's patch together (both or neither). */
  recordLog(entry: LogEntryRow, patch: ContactPatch): Promise<void>
  /** A contact's log entries, newest day first (then newest logged first). */
  logEntries(contactId: string): Promise<LogEntryRow[]>
}

/** Display names of the people in the company. */
export type Directory = {
  names(): Promise<Map<string, string>>
}
