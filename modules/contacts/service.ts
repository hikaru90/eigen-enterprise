import type { ContactPatch, ContactRow, ContactScope, ContactsStore, Directory } from './store'
import { randomUUID } from 'node:crypto'
import type { MemberRole } from '$lib/server/auth/user-role'
import { ContactsError } from './errors'
import {
  CHANNEL_TYPES,
  CONTACT_LIMITS,
  DEFAULT_TAGS,
  FOLLOW_UP_WINDOW_DAYS,
  type Channel,
  type ChannelType,
  type ContactDto,
  type FollowUpDto,
} from './types'

/**
 * Contacts core: the people the company knows. Access is decided here, server
 * side, on every call (the tables carry no RLS, like Drive's and Contribute's):
 * - a contact is private to whoever added it, plus the company owner and
 *   admins — the same rule Drive applies to an unshared item;
 * - shared with the company, everyone in the company sees and updates it;
 *   only its creator, the owner and admins share/unshare or delete it;
 * - a contact the viewer can't see is "not found" (its existence is not
 *   leaked); one they see but may not manage is "forbidden";
 * - the agent on its own (no person behind it) acts with admin rights, like
 *   Drive's agent; it never shares or deletes. Working for a person, the
 *   agent is that person (tools.ts resolves this).
 * Kernel events carry ids and field names only — never a contact's details.
 */

export type Actor = { kind: 'user'; userId: string } | { kind: 'agent'; id: string }

export type ContactsAudit = (event: { type: string; principalId: string; payload: Record<string, unknown> }) => Promise<void>

export type ContactsDeps = {
  store: ContactsStore
  directory: Directory
  /** The person's company role, or null when no such user exists. */
  roleOf: (userId: string) => Promise<MemberRole | null>
  /** Kernel events (audit); required. */
  audit: ContactsAudit
  now?: () => Date
  newId?: () => string
}

/** The editable fields, as they arrive from a form or a tool (validated here). */
export type ContactInput = {
  name?: unknown
  organisation?: unknown
  title?: unknown
  channels?: unknown
  metHow?: unknown
  whyRelevant?: unknown
  tags?: unknown
  lastContactedOn?: unknown
  nextFollowUpOn?: unknown
  nextStep?: unknown
}

const FIELDS = [
  'name',
  'organisation',
  'title',
  'channels',
  'metHow',
  'whyRelevant',
  'tags',
  'lastContactedOn',
  'nextFollowUpOn',
  'nextStep',
] as const satisfies ReadonlyArray<keyof ContactInput>

const now = (d: ContactsDeps) => (d.now ? d.now() : new Date())
const newId = (d: ContactsDeps) => (d.newId ? d.newId() : randomUUID())

// ── boundary parsing (fail loud with the constraint) ──────────────────────────

function parseName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ContactsError('invalid', 'Give the contact a name.')
  const name = value.trim()
  if (name.length > CONTACT_LIMITS.name) throw new ContactsError('invalid', `A name can be at most ${CONTACT_LIMITS.name} characters.`)
  return name
}

/** Optional text: undefined = not sent, null or blank = clear it. */
function optionalText(value: unknown, label: string, max: number): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new ContactsError('invalid', `${label} must be text`)
  const text = value.trim()
  if (text === '') return null
  if (text.length > max) throw new ContactsError('invalid', `${label} can be at most ${max} characters.`)
  return text
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** A day (`YYYY-MM-DD`): undefined = not sent, null or blank = clear it. */
function optionalDay(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value === 'string' && DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value) return value
  throw new ContactsError('invalid', `${label} must be a date (YYYY-MM-DD), got ${JSON.stringify(value)}`)
}

function requiredDay(value: unknown, label: string): string {
  const day = optionalDay(value, label)
  if (!day) throw new ContactsError('invalid', `Say which day: ${label} must be a date (YYYY-MM-DD).`)
  return day
}

function parseChannels(value: unknown): Channel[] {
  if (!Array.isArray(value)) throw new ContactsError('invalid', 'channels must be a list of {type, value}')
  if (value.length > CONTACT_LIMITS.channels) throw new ContactsError('invalid', `At most ${CONTACT_LIMITS.channels} channels per contact.`)
  return value.map((raw: unknown) => {
    const c = (raw ?? {}) as { type?: unknown; value?: unknown }
    if (typeof c.type !== 'string' || !(CHANNEL_TYPES as readonly string[]).includes(c.type)) {
      throw new ContactsError('invalid', `unknown channel type ${JSON.stringify(c.type ?? null)} (use ${CHANNEL_TYPES.join(', ')})`)
    }
    if (typeof c.value !== 'string' || c.value.trim() === '') {
      throw new ContactsError('invalid', 'Every channel needs a value: an address, a number or a link.')
    }
    const v = c.value.trim()
    if (v.length > CONTACT_LIMITS.channelValue) {
      throw new ContactsError('invalid', `A channel value can be at most ${CONTACT_LIMITS.channelValue} characters.`)
    }
    return { type: c.type as ChannelType, value: v }
  })
}

/** One tag as stored: trimmed, single spaces, lower case (so "Investor" and "investor" are one tag). */
export function normaliseTag(value: unknown): string {
  if (typeof value !== 'string') throw new ContactsError('invalid', 'A tag must be text.')
  const tag = value.trim().replace(/\s+/g, ' ').toLowerCase()
  if (tag === '') throw new ContactsError('invalid', 'A tag can’t be empty.')
  if (tag.length > CONTACT_LIMITS.tag) throw new ContactsError('invalid', `A tag can be at most ${CONTACT_LIMITS.tag} characters.`)
  return tag
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ContactsError('invalid', 'tags must be a list of words')
  const tags = [...new Set(value.map(normaliseTag))]
  if (tags.length > CONTACT_LIMITS.tags) throw new ContactsError('invalid', `At most ${CONTACT_LIMITS.tags} tags per contact.`)
  return tags
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value.trim())) {
    throw new ContactsError('invalid', `id must be a contact id (UUID), got ${JSON.stringify(value ?? null)}`)
  }
  return value.trim().toLowerCase()
}

/** Every field the input sends, validated (absent ones stay absent). */
function parseFields(input: ContactInput): Omit<ContactPatch, 'updatedAt' | 'shared'> {
  const out: Omit<ContactPatch, 'updatedAt' | 'shared'> = {}
  if (input.name !== undefined) out.name = parseName(input.name)
  const organisation = optionalText(input.organisation, 'An organisation', CONTACT_LIMITS.organisation)
  if (organisation !== undefined) out.organisation = organisation
  const title = optionalText(input.title, 'A role or title', CONTACT_LIMITS.title)
  if (title !== undefined) out.title = title
  if (input.channels !== undefined) out.channels = input.channels === null ? [] : parseChannels(input.channels)
  const metHow = optionalText(input.metHow, 'Where you met', CONTACT_LIMITS.metHow)
  if (metHow !== undefined) out.metHow = metHow
  const whyRelevant = optionalText(input.whyRelevant, 'Why they matter', CONTACT_LIMITS.whyRelevant)
  if (whyRelevant !== undefined) out.whyRelevant = whyRelevant
  if (input.tags !== undefined) out.tags = input.tags === null ? [] : parseTags(input.tags)
  const lastContactedOn = optionalDay(input.lastContactedOn, 'Last contacted')
  if (lastContactedOn !== undefined) out.lastContactedOn = lastContactedOn
  const nextFollowUpOn = optionalDay(input.nextFollowUpOn, 'Next follow-up')
  if (nextFollowUpOn !== undefined) out.nextFollowUpOn = nextFollowUpOn
  const nextStep = optionalText(input.nextStep, 'A next step', CONTACT_LIMITS.nextStep)
  if (nextStep !== undefined) out.nextStep = nextStep
  return out
}

// ── who is looking ────────────────────────────────────────────────────────────

/** The actor's standing: `all` = sees every contact (owner, admins, the agent on its own). */
type Viewer = { principalId: string; userId: string | null; all: boolean }

async function viewerOf(d: ContactsDeps, actor: Actor): Promise<Viewer> {
  if (actor.kind === 'agent') return { principalId: actor.id, userId: null, all: true }
  const role = await d.roleOf(actor.userId)
  if (!role) throw new ContactsError('forbidden', 'Only people in the company use Contacts.')
  return { principalId: actor.userId, userId: actor.userId, all: role === 'owner' || role === 'admin' }
}

const isOwn = (v: Viewer, row: ContactRow) => v.userId !== null && row.createdByKind === 'user' && row.createdBy === v.userId
const canSee = (v: Viewer, row: ContactRow) => v.all || row.shared || isOwn(v, row)
/** Share/unshare and delete: a person who added it, the owner, admins — never the agent. */
const canManage = (v: Viewer, row: ContactRow) => v.userId !== null && (v.all || isOwn(v, row))

function toDto(row: ContactRow, names: Map<string, string>, v: Viewer): ContactDto {
  return {
    id: row.id,
    name: row.name,
    organisation: row.organisation,
    title: row.title,
    channels: row.channels.map((c) => ({ ...c })),
    metHow: row.metHow,
    whyRelevant: row.whyRelevant,
    tags: [...row.tags],
    lastContactedOn: row.lastContactedOn,
    nextFollowUpOn: row.nextFollowUpOn,
    nextStep: row.nextStep,
    shared: row.shared,
    own: isOwn(v, row),
    createdByName: row.createdByKind === 'agent' ? 'the agent' : (names.get(row.createdBy) ?? 'a former member'),
    canManage: canManage(v, row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function visibleRow(d: ContactsDeps, v: Viewer, rawId: unknown): Promise<ContactRow> {
  const row = await d.store.get(parseId(rawId))
  if (!row || !canSee(v, row)) throw new ContactsError('not_found', 'contact not found')
  return row
}

async function view(d: ContactsDeps, v: Viewer, id: string): Promise<ContactDto> {
  const row = await d.store.get(id)
  if (!row) throw new ContactsError('not_found', 'contact not found')
  return toDto(row, await d.directory.names(), v)
}

const scopeOf = (v: Viewer): ContactScope => (v.all || v.userId === null ? { kind: 'all' } : { kind: 'person', userId: v.userId })

// ── reads ─────────────────────────────────────────────────────────────────────

/**
 * The contacts the actor sees, by name, optionally one tag and a search over
 * name and organisation (a plain lookup). `tags` = the default tags, then the
 * ones in use on contacts the actor sees.
 */
export async function listContacts(
  d: ContactsDeps,
  actor: Actor,
  filter: { tag?: unknown; query?: unknown } = {},
): Promise<{ contacts: ContactDto[]; tags: string[] }> {
  const v = await viewerOf(d, actor)
  const tag = typeof filter.tag === 'string' && filter.tag.trim() !== '' ? normaliseTag(filter.tag) : undefined
  const query = typeof filter.query === 'string' && filter.query.trim() !== '' ? filter.query.trim().slice(0, CONTACT_LIMITS.name) : undefined
  const scope = scopeOf(v)
  const [rows, tags, names] = await Promise.all([
    d.store.list(scope, { ...(tag ? { tag } : {}), ...(query ? { query } : {}) }),
    tagsIn(d, scope),
    d.directory.names(),
  ])
  return { contacts: rows.map((r) => toDto(r, names, v)), tags }
}

async function tagsIn(d: ContactsDeps, scope: ContactScope): Promise<string[]> {
  const defaults: readonly string[] = DEFAULT_TAGS
  return [...DEFAULT_TAGS, ...(await d.store.tags(scope)).filter((t) => !defaults.includes(t))]
}

/** The tags to offer: the default ones, then the ones in use on contacts the actor sees. */
export async function contactTags(d: ContactsDeps, actor: Actor): Promise<string[]> {
  return tagsIn(d, scopeOf(await viewerOf(d, actor)))
}

export async function getContact(d: ContactsDeps, actor: Actor, rawId: unknown): Promise<ContactDto> {
  const v = await viewerOf(d, actor)
  return toDto(await visibleRow(d, v, rawId), await d.directory.names(), v)
}

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000

function addDays(day: string, days: number): string {
  return new Date((dayNumber(day) + days) * 86_400_000).toISOString().slice(0, 10)
}

/**
 * "Follow up next" — who to write to next: contacts with a follow-up that is
 * due (today or earlier) or comes up within FOLLOW_UP_WINDOW_DAYS, soonest
 * first. Personal: a person gets their own and the shared contacts (the owner
 * and admins too — other people's private follow-ups aren't theirs to do);
 * the agent on its own gets every one.
 */
export async function followUps(d: ContactsDeps, actor: Actor, rawToday: unknown): Promise<FollowUpDto[]> {
  const today = requiredDay(rawToday, 'today')
  const v = await viewerOf(d, actor)
  const scope: ContactScope = v.userId === null ? { kind: 'all' } : { kind: 'person', userId: v.userId }
  const [rows, names] = await Promise.all([d.store.followUps(scope, addDays(today, FOLLOW_UP_WINDOW_DAYS)), d.directory.names()])
  return rows.map((row) => {
    const daysFromToday = dayNumber(row.nextFollowUpOn!) - dayNumber(today)
    return {
      ...toDto(row, names, v),
      nextFollowUpOn: row.nextFollowUpOn!,
      due: daysFromToday < 0 ? 'overdue' : daysFromToday === 0 ? 'today' : 'upcoming',
      daysFromToday,
    }
  })
}

// ── writes ────────────────────────────────────────────────────────────────────

/** Add a contact: private to its creator unless a person shares it with the company right away. */
export async function createContact(
  d: ContactsDeps,
  actor: Actor,
  input: ContactInput,
  opts: { shared?: boolean } = {},
): Promise<ContactDto> {
  const v = await viewerOf(d, actor)
  const name = parseName(input.name)
  const fields = parseFields(input)
  const shared = opts.shared === true
  if (shared && v.userId === null) throw new ContactsError('forbidden', 'Only a person shares a contact with the company.')
  const at = now(d)
  const row: ContactRow = {
    id: newId(d),
    name,
    organisation: fields.organisation ?? null,
    title: fields.title ?? null,
    channels: fields.channels ?? [],
    metHow: fields.metHow ?? null,
    whyRelevant: fields.whyRelevant ?? null,
    tags: fields.tags ?? [],
    lastContactedOn: fields.lastContactedOn ?? null,
    nextFollowUpOn: fields.nextFollowUpOn ?? null,
    nextStep: fields.nextStep ?? null,
    createdBy: v.principalId,
    createdByKind: v.userId === null ? 'agent' : 'user',
    shared,
    createdAt: at,
    updatedAt: at,
  }
  await d.store.insert(row)
  await d.audit({ type: 'contacts.created', principalId: v.principalId, payload: { id: row.id, shared } })
  return view(d, v, row.id)
}

/** Change the fields that are sent; blank text or null clears an optional field. */
export async function updateContact(d: ContactsDeps, actor: Actor, rawId: unknown, input: ContactInput): Promise<ContactDto> {
  const v = await viewerOf(d, actor)
  const row = await visibleRow(d, v, rawId)
  const fields = parseFields(input)
  const changed = FIELDS.filter((f) => f in fields)
  if (changed.length === 0) throw new ContactsError('invalid', 'Nothing to change.')
  await d.store.update(row.id, { ...fields, updatedAt: now(d) })
  await d.audit({ type: 'contacts.updated', principalId: v.principalId, payload: { id: row.id, fields: changed } })
  return view(d, v, row.id)
}

/**
 * "Log a contact": you were in touch on `on`. The follow-up it answered is
 * done, so the next one is replaced by what is sent (none when left out).
 */
export async function logContact(
  d: ContactsDeps,
  actor: Actor,
  rawId: unknown,
  input: { on: unknown; nextFollowUpOn?: unknown; nextStep?: unknown },
): Promise<ContactDto> {
  const v = await viewerOf(d, actor)
  const row = await visibleRow(d, v, rawId)
  const on = requiredDay(input.on, 'the day you were in touch')
  const nextFollowUpOn = optionalDay(input.nextFollowUpOn, 'Next follow-up') ?? null
  const nextStep = optionalText(input.nextStep, 'A next step', CONTACT_LIMITS.nextStep) ?? null
  if (nextFollowUpOn !== null && nextFollowUpOn < on) {
    throw new ContactsError('invalid', 'The next follow-up can’t be before the day you were in touch.')
  }
  await d.store.update(row.id, { lastContactedOn: on, nextFollowUpOn, nextStep, updatedAt: now(d) })
  await d.audit({ type: 'contacts.contact_logged', principalId: v.principalId, payload: { id: row.id } })
  return view(d, v, row.id)
}

/** Share with the company (true) or make private again (false): its creator, the owner, admins. */
export async function setShared(d: ContactsDeps, actor: Actor, rawId: unknown, shared: unknown): Promise<ContactDto> {
  if (typeof shared !== 'boolean') throw new ContactsError('invalid', 'shared must be true or false')
  const v = await viewerOf(d, actor)
  const row = await visibleRow(d, v, rawId)
  if (!canManage(v, row)) {
    throw new ContactsError('forbidden', 'Only the person who added this contact, the owner and admins change who can see it.')
  }
  if (row.shared !== shared) {
    await d.store.update(row.id, { shared, updatedAt: now(d) })
    await d.audit({ type: 'contacts.sharing_changed', principalId: v.principalId, payload: { id: row.id, shared } })
  }
  return view(d, v, row.id)
}

/** Delete for good: its creator, the owner, admins. */
export async function deleteContact(d: ContactsDeps, actor: Actor, rawId: unknown): Promise<void> {
  const v = await viewerOf(d, actor)
  const row = await visibleRow(d, v, rawId)
  if (!canManage(v, row)) {
    throw new ContactsError('forbidden', 'Only the person who added this contact, the owner and admins can delete it.')
  }
  await d.store.delete(row.id)
  await d.audit({ type: 'contacts.deleted', principalId: v.principalId, payload: { id: row.id } })
}
