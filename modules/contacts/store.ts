import type { Channel, ContactVisibility, PipelineStage, Via } from './types'

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
  /** The pipeline list (migration 0144). */
  stage: PipelineStage
  /** Who on our side holds it (a member's user id). */
  ownerId: string | null
  via: Via | null
  latestStatus: string | null
  /** Set exactly while stage = waiting (the DB checks it). */
  waitingSince: string | null
  /** A person's user id, or the agent's principal id when no person was behind it. */
  createdBy: string
  createdByKind: 'user' | 'agent'
  /** Shared with the whole team: every member, now and later (checked at read time, never a copy of member ids). */
  shared: boolean
  createdAt: Date
  updatedAt: Date
}

export type ContactPatch = Partial<
  Pick<
    ContactRow,
    | 'name'
    | 'organisation'
    | 'title'
    | 'channels'
    | 'metHow'
    | 'whyRelevant'
    | 'tags'
    | 'lastContactedOn'
    | 'nextFollowUpOn'
    | 'nextStep'
    | 'stage'
    | 'ownerId'
    | 'via'
    | 'latestStatus'
    | 'waitingSince'
    | 'shared'
  >
> & { updatedAt: Date }

/** One "Log a contact" (migration 0139): the day, how it went, the follow-up it answered and the one it set. */
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
 * on its own) or what one person sees — their own, the ones shared with the
 * whole team, and the ones shared with them or with a group they are in
 * (group membership as it is at the time of the query).
 */
export type ContactScope = { kind: 'all' } | { kind: 'person'; userId: string }

/** A list filter: one tag (exact, normalised), a name/organisation search, and/or these ids only. */
export type ContactFilter = { tag?: string; query?: string; ids?: readonly string[] }

/** One person or group a contact is shared with (migration 0150). */
export type ShareRow = { contactId: string; kind: 'user' | 'group'; subjectId: string }

/** A bulk change of who sees contacts: add shares, or make them private (no shares at all). */
export type SharingChange = { kind: 'share'; team: boolean; userIds: readonly string[]; groupIds: readonly string[] } | { kind: 'private' }

/** The stored defaults for new contacts: the person's own choice and the company's (null = not set). */
export type StoredDefaults = { person: ContactVisibility | null; company: ContactVisibility | null }

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
  /** The people and groups these contacts are shared with. */
  shares(contactIds: readonly string[]): Promise<ShareRow[]>
  /** Applies one sharing change to every one of these contacts, together (all or none). */
  applySharing(contactIds: readonly string[], change: SharingChange, grantedBy: string, at: Date): Promise<void>
  /** The person's and the company's default for new contacts. */
  defaults(userId: string | null): Promise<StoredDefaults>
  /** The person's own default (null = follow the company's). */
  setPersonDefault(userId: string, visibility: ContactVisibility | null): Promise<void>
  /** The company-wide default (null = private). */
  setCompanyDefault(visibility: ContactVisibility | null, by: string): Promise<void>
}

/** A group of company members (Members › Groups). */
export type DirectoryGroup = { id: string; name: string; memberIds: string[] }

/** Display names of the people in the company, and its groups. */
export type Directory = {
  names(): Promise<Map<string, string>>
  groups(): Promise<DirectoryGroup[]>
}

/** One person's cached "Next up" pick (migration 0145). `suggestions` is checked by the service on read. */
export type NextUpEntry = { userId: string; day: string; generatedAt: Date; suggestions: unknown }

/** Where the last pick per person is kept: the DB in production, in memory in unit tests. */
export type NextUpCache = {
  get(userId: string): Promise<NextUpEntry | null>
  /** Replaces the person's pick. */
  put(entry: NextUpEntry): Promise<void>
}
