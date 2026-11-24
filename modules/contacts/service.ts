import type { ContactPatch, ContactRow, ContactScope, ContactsStore, Directory, LogEntryRow, ShareRow, SharingChange } from './store'
import { randomUUID } from 'node:crypto'
import type { CoreEventType } from '$lib/kernel/event-catalog'
import type { MemberRole } from '$lib/server/auth/user-role'
import { ContactsError } from './errors'
import {
  CHANNEL_TYPES,
  CONTACT_LIMITS,
  CONTACT_VISIBILITIES,
  DEFAULT_TAGS,
  FOLLOW_UP_WINDOW_DAYS,
  IMPORT_MAX,
  PIPELINE_STAGES,
  VIA_TYPES,
  WAITING_REVIEW_DAYS,
  dayIn,
  type Channel,
  type ChannelType,
  type ContactDto,
  type ContactVisibility,
  type FollowUpDto,
  type HistoryItem,
  type ImportCandidate,
  type ImportPreview,
  type ImportPreviewRow,
  type Pipeline,
  type PipelineItem,
  type PipelineStage,
  type ShareChoices,
  type SharedWith,
  type SharingResult,
  type Via,
  type VisibilityDefaults,
} from './types'

/**
 * Contacts core: the people the company knows. Access is decided here, server
 * side, on every call (the tables carry no RLS, like Drive's and Contribute's):
 * - a contact is private to whoever added it, plus the company owner and
 *   admins — the same rule Drive applies to an unshared item;
 * - shared with the whole team (contacts.shared), every member of the
 *   company sees and updates it — whoever joins later too, since it is
 *   checked when contacts are read (migration 0150, Contribute 9d28020a);
 * - shared with people or groups (contact_shares), they see and update it;
 *   a group share follows the group's membership as it is when read;
 * - only its creator, the owner and admins change who sees it or delete it;
 * - a new contact starts as the person's own default (Contacts settings),
 *   else the company's (set by the owner or an admin), else private;
 * - a contact the viewer can't see is "not found" (its existence is not
 *   leaked); one they see but may not manage is "forbidden";
 * - the agent on its own (no person behind it) acts with admin rights, like
 *   Drive's agent; it never shares or deletes. Working for a person, the
 *   agent is that person (tools.ts resolves this).
 * Kernel events carry ids and field names only — never a contact's details.
 */

export type Actor = { kind: 'user'; userId: string } | { kind: 'agent'; id: string }

export type ContactsAudit = (event: { type: CoreEventType; principalId: string; payload: Record<string, unknown> }) => Promise<void>

/** One mail with a contact's address, as the mail port found it. */
export type ContactMail = Omit<Extract<HistoryItem, { kind: 'mail' }>, 'kind' | 'day' | 'at'> & { at: Date }

/**
 * Mail exchanged with these addresses (lower case) that this person may read:
 * the mailboxes they read under Email's own rules, and the company's sending
 * when the Company-mail rule lets them. The port decides access (wired by
 * the people routes over Email's own functions); Contacts never reads a
 * mailbox on its own.
 */
export type ContactMailPort = (userId: string, addresses: string[]) => Promise<ContactMail[]>

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
  /** The pipeline list: next, waiting, keep_in_touch, inbox. */
  stage?: unknown
  /** Who on our side holds it: a company member's user id (null clears). */
  ownerId?: unknown
  via?: unknown
  latestStatus?: unknown
  /** Only while waiting: since when (defaults to today when the wait starts). */
  waitingSince?: unknown
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
  'stage',
  'ownerId',
  'via',
  'latestStatus',
  'waitingSince',
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

function parseStage(value: unknown): PipelineStage {
  if (typeof value === 'string' && (PIPELINE_STAGES as readonly string[]).includes(value)) return value as PipelineStage
  throw new ContactsError('invalid', `stage must be one of ${PIPELINE_STAGES.join(', ')}, got ${JSON.stringify(value ?? null)}`)
}

/** How we are in touch: undefined = not sent, null or blank = clear it. */
function optionalVia(value: unknown): Via | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value === 'string' && (VIA_TYPES as readonly string[]).includes(value)) return value as Via
  throw new ContactsError('invalid', `via must be one of ${VIA_TYPES.join(', ')}, got ${JSON.stringify(value)}`)
}

/** A member's user id as sent (checked against the company in checkOwner): undefined = not sent, null or blank = nobody. */
function optionalOwner(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new ContactsError('invalid', 'ownerId must be a member’s user id')
  return value.trim()
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
  if (input.stage !== undefined) out.stage = parseStage(input.stage)
  const ownerId = optionalOwner(input.ownerId)
  if (ownerId !== undefined) out.ownerId = ownerId
  const via = optionalVia(input.via)
  if (via !== undefined) out.via = via
  const latestStatus = optionalText(input.latestStatus, 'A latest status', CONTACT_LIMITS.latestStatus)
  if (latestStatus !== undefined) out.latestStatus = latestStatus
  const waitingSince = optionalDay(input.waitingSince, 'Waiting since')
  if (waitingSince !== undefined) out.waitingSince = waitingSince
  return out
}

/** The person who holds a contact must be in the company (fail loud otherwise). */
async function checkOwner(d: ContactsDeps, ownerId: string | null | undefined): Promise<void> {
  if (ownerId === undefined || ownerId === null) return
  if (!(await d.roleOf(ownerId))) {
    throw new ContactsError('invalid', `${JSON.stringify(ownerId)} is not in the company, so they can’t hold a contact.`)
  }
}

/**
 * The stage and the day the wait began, together: waiting has a waiting-since
 * day (the one sent, the one it already had, else `today`), every other list
 * has none. Never guessed from text — the stage is what was sent or what it was.
 */
function resolveStage(
  current: { stage: PipelineStage; waitingSince: string | null },
  fields: { stage?: PipelineStage; waitingSince?: string | null },
  today: string | undefined,
): { stage: PipelineStage; waitingSince: string | null } {
  const stage = fields.stage ?? current.stage
  if (stage !== 'waiting') {
    if (fields.waitingSince) throw new ContactsError('invalid', 'Only a contact you are waiting on has a “waiting since” day.')
    return { stage, waitingSince: null }
  }
  if (fields.waitingSince === null) throw new ContactsError('invalid', 'Waiting for a reply needs the day the wait began.')
  const waitingSince = fields.waitingSince ?? (current.stage === 'waiting' ? current.waitingSince : null) ?? today ?? null
  if (waitingSince === null) {
    throw new ContactsError('invalid', 'Say since when you are waiting for their reply (waitingSince, YYYY-MM-DD).')
  }
  return { stage, waitingSince }
}

/** `today` as callers pass it: a day, or absent. */
const optionalToday = (value: unknown) => (value === undefined ? undefined : requiredDay(value, 'today'))

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
/** Share/unshare and delete: a person who added it, the owner, admins — never the agent. */
const canManage = (v: Viewer, row: ContactRow) => v.userId !== null && (v.all || isOwn(v, row))

/** What a DTO needs besides the row: names, groups, the viewer's groups and the rows' shares. */
type DtoContext = {
  names: Map<string, string>
  groupNames: Map<string, string>
  viewerGroups: Set<string>
  shares: Map<string, ShareRow[]>
}

async function dtoContext(d: ContactsDeps, v: Viewer, rows: readonly ContactRow[]): Promise<DtoContext> {
  const [names, groups, shares] = await Promise.all([
    d.directory.names(),
    d.directory.groups(),
    rows.length === 0 ? Promise.resolve([]) : d.store.shares(rows.map((r) => r.id)),
  ])
  const byContact = new Map<string, ShareRow[]>()
  for (const sh of shares) byContact.set(sh.contactId, [...(byContact.get(sh.contactId) ?? []), sh])
  return {
    names,
    groupNames: new Map(groups.map((g) => [g.id, g.name])),
    viewerGroups: new Set(v.userId === null ? [] : groups.filter((g) => g.memberIds.includes(v.userId!)).map((g) => g.id)),
    shares: byContact,
  }
}

function sharedWithOf(row: ContactRow, ctx: DtoContext): SharedWith[] {
  return (ctx.shares.get(row.id) ?? []).map((sh) => ({
    kind: sh.kind,
    id: sh.subjectId,
    name: sh.kind === 'user' ? (ctx.names.get(sh.subjectId) ?? 'a former member') : (ctx.groupNames.get(sh.subjectId) ?? 'a deleted group'),
  }))
}

function toDto(row: ContactRow, ctx: DtoContext, v: Viewer): ContactDto {
  const names = ctx.names
  const shares = ctx.shares.get(row.id) ?? []
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
    stage: row.stage,
    ownerId: row.ownerId,
    ownerName: row.ownerId === null ? null : (names.get(row.ownerId) ?? 'a former member'),
    via: row.via,
    latestStatus: row.latestStatus,
    waitingSince: row.waitingSince,
    shared: row.shared,
    sharedWith: sharedWithOf(row, ctx),
    sharedWithViewer:
      v.userId !== null && shares.some((sh) => (sh.kind === 'user' ? sh.subjectId === v.userId : ctx.viewerGroups.has(sh.subjectId))),
    own: isOwn(v, row),
    createdByName: row.createdByKind === 'agent' ? 'the agent' : (names.get(row.createdBy) ?? 'a former member'),
    canManage: canManage(v, row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

const scopeOf = (v: Viewer): ContactScope => (v.all || v.userId === null ? { kind: 'all' } : { kind: 'person', userId: v.userId })

/** The contact if the viewer sees it — decided by the store's scope, the one place visibility lives. */
async function visibleRow(d: ContactsDeps, v: Viewer, rawId: unknown): Promise<ContactRow> {
  const id = parseId(rawId)
  const [row] = await d.store.list(scopeOf(v), { ids: [id] })
  if (!row) throw new ContactsError('not_found', 'contact not found')
  return row
}

async function dtos(d: ContactsDeps, v: Viewer, rows: readonly ContactRow[]): Promise<ContactDto[]> {
  const ctx = await dtoContext(d, v, rows)
  return rows.map((r) => toDto(r, ctx, v))
}

async function view(d: ContactsDeps, v: Viewer, id: string): Promise<ContactDto> {
  const row = await d.store.get(id)
  if (!row) throw new ContactsError('not_found', 'contact not found')
  return (await dtos(d, v, [row]))[0]!
}

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
  const [rows, tags] = await Promise.all([d.store.list(scope, { ...(tag ? { tag } : {}), ...(query ? { query } : {}) }), tagsIn(d, scope)])
  return { contacts: await dtos(d, v, rows), tags }
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
  return (await dtos(d, v, [await visibleRow(d, v, rawId)]))[0]!
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
  const rows = await d.store.followUps(scope, addDays(today, FOLLOW_UP_WINDOW_DAYS))
  const ctx = await dtoContext(d, v, rows)
  return rows.map((row) => {
    const daysFromToday = dayNumber(row.nextFollowUpOn!) - dayNumber(today)
    return {
      ...toDto(row, ctx, v),
      nextFollowUpOn: row.nextFollowUpOn!,
      due: daysFromToday < 0 ? 'overdue' : daysFromToday === 0 ? 'today' : 'upcoming',
      daysFromToday,
    }
  })
}

/** Soonest day first, contacts without one last; then by name. */
function bySoonest(day: (i: PipelineItem) => string | null) {
  return (a: PipelineItem, b: PipelineItem) => {
    const da = day(a)
    const db = day(b)
    if (da !== db) return da === null ? 1 : db === null ? -1 : da.localeCompare(db)
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id)
  }
}

/**
 * The pipeline (Contribute 8c6a0cb7, GTD): every contact the actor sees (like
 * the list), in the list a person put it in — our move (next actions),
 * waiting for a reply, keep in the loop (tickler), not contacted yet (inbox) —
 * with what the weekly review should look at: a follow-up or tickler day that
 * has passed, a reply waited on for longer than WAITING_REVIEW_DAYS, our move
 * with no next step written down, and whatever is still in the inbox.
 */
export async function pipeline(d: ContactsDeps, actor: Actor, rawToday: unknown): Promise<Pipeline> {
  const today = requiredDay(rawToday, 'today')
  const v = await viewerOf(d, actor)
  const rows = await d.store.list(scopeOf(v), {})
  const ctx = await dtoContext(d, v, rows)
  const names = ctx.names
  const items = rows.map((row): PipelineItem => {
    const daysFromToday = row.nextFollowUpOn === null ? null : dayNumber(row.nextFollowUpOn) - dayNumber(today)
    const daysWaiting = row.stage === 'waiting' && row.waitingSince !== null ? dayNumber(today) - dayNumber(row.waitingSince) : null
    const overdue = daysFromToday !== null && daysFromToday < 0
    const staleWaiting = daysWaiting !== null && daysWaiting > WAITING_REVIEW_DAYS
    const missingNextStep = row.stage === 'next' && row.nextStep === null
    return {
      ...toDto(row, ctx, v),
      review: {
        daysFromToday,
        overdue,
        daysWaiting,
        staleWaiting,
        missingNextStep,
        needsReview: overdue || staleWaiting || missingNextStep || row.stage === 'inbox',
      },
    }
  })
  const order = (stage: PipelineStage) =>
    stage === 'waiting' ? bySoonest((i) => i.waitingSince) : stage === 'inbox' ? bySoonest(() => null) : bySoonest((i) => i.nextFollowUpOn)
  const groups = PIPELINE_STAGES.map((stage) => ({ stage, items: items.filter((i) => i.stage === stage).sort(order(stage)) }))
  const count = (p: (i: PipelineItem) => boolean) => items.filter(p).length
  return {
    today,
    groups,
    review: {
      waitingTooLong: count((i) => i.review.staleWaiting),
      overdue: count((i) => i.review.overdue),
      nextWithoutStep: count((i) => i.review.missingNextStep),
      inbox: count((i) => i.stage === 'inbox'),
      waitingDays: WAITING_REVIEW_DAYS,
    },
    people: [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

// ── writes ────────────────────────────────────────────────────────────────────

/**
 * Add a contact. `shared` is the person's choice on the form (true = whole
 * team, false = private); left out, it starts as their default (theirs, else
 * the company's, else private). The agent on its own never chooses: its
 * contacts follow the company default.
 */
export async function createContact(
  d: ContactsDeps,
  actor: Actor,
  input: ContactInput,
  opts: { shared?: boolean; today?: unknown } = {},
): Promise<ContactDto> {
  const v = await viewerOf(d, actor)
  const name = parseName(input.name)
  const fields = parseFields(input)
  await checkOwner(d, fields.ownerId)
  const placed = resolveStage({ stage: 'inbox', waitingSince: null }, fields, optionalToday(opts.today))
  if (opts.shared !== undefined && typeof opts.shared !== 'boolean') throw new ContactsError('invalid', 'shared must be true or false')
  if (opts.shared === true && v.userId === null) throw new ContactsError('forbidden', 'Only a person shares a contact with the company.')
  const shared = opts.shared ?? (await defaultsOf(d, v)).effective === 'team'
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
    ...placed,
    // Held by whoever adds it, unless they say otherwise (the agent on its own: nobody).
    ownerId: fields.ownerId !== undefined ? fields.ownerId : v.userId,
    via: fields.via ?? null,
    latestStatus: fields.latestStatus ?? null,
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
export async function updateContact(
  d: ContactsDeps,
  actor: Actor,
  rawId: unknown,
  input: ContactInput,
  opts: { today?: unknown } = {},
): Promise<ContactDto> {
  const v = await viewerOf(d, actor)
  const row = await visibleRow(d, v, rawId)
  const fields = parseFields(input)
  if (FIELDS.every((f) => !(f in fields))) throw new ContactsError('invalid', 'Nothing to change.')
  await checkOwner(d, fields.ownerId)
  const placed = resolveStage(row, fields, optionalToday(opts.today))
  // The wait's day follows the stage: recorded as a change only when it does change.
  if (placed.waitingSince !== row.waitingSince) fields.waitingSince = placed.waitingSince
  const changed = FIELDS.filter((f) => f in fields)
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
  input: {
    on: unknown
    note?: unknown
    nextFollowUpOn?: unknown
    nextStep?: unknown
    /** Where they are now (left out or blank: the list stays as it is). "waiting" starts the wait on `on`. */
    stage?: unknown
    via?: unknown
    latestStatus?: unknown
  },
): Promise<ContactDto> {
  const v = await viewerOf(d, actor)
  const row = await visibleRow(d, v, rawId)
  const on = requiredDay(input.on, 'the day you were in touch')
  const note = optionalText(input.note, 'How it went', CONTACT_LIMITS.logNote) ?? null
  const nextFollowUpOn = optionalDay(input.nextFollowUpOn, 'Next follow-up') ?? null
  const nextStep = optionalText(input.nextStep, 'A next step', CONTACT_LIMITS.nextStep) ?? null
  if (nextFollowUpOn !== null && nextFollowUpOn < on) {
    throw new ContactsError('invalid', 'The next follow-up can’t be before the day you were in touch.')
  }
  const stage = input.stage === undefined || input.stage === '' ? undefined : parseStage(input.stage)
  const via = optionalVia(input.via)
  const latestStatus = optionalText(input.latestStatus, 'A latest status', CONTACT_LIMITS.latestStatus)
  // Moved to "waiting" here: a new wait starts on the day you were in touch.
  const placed =
    stage === undefined
      ? { stage: row.stage, waitingSince: row.waitingSince }
      : resolveStage({ stage: row.stage, waitingSince: null }, { stage, waitingSince: stage === 'waiting' ? on : undefined }, on)
  const at = now(d)
  // The history keeps what was due (the follow-up this answered) and what comes next.
  const entry: LogEntryRow = {
    id: newId(d),
    contactId: row.id,
    on,
    note,
    answeredFollowUpOn: row.nextFollowUpOn,
    answeredStep: row.nextStep,
    nextFollowUpOn,
    nextStep,
    loggedBy: v.principalId,
    loggedByKind: v.userId === null ? 'agent' : 'user',
    createdAt: at,
  }
  await d.store.recordLog(entry, {
    lastContactedOn: on,
    nextFollowUpOn,
    nextStep,
    ...placed,
    ...(via !== undefined ? { via } : {}),
    ...(latestStatus !== undefined ? { latestStatus } : {}),
    updatedAt: at,
  })
  await d.audit({ type: 'contacts.contact_logged', principalId: v.principalId, payload: { id: row.id } })
  return view(d, v, row.id)
}

/** The contact's email addresses, lower case, each once (the mail port matches them exactly). */
function emailAddresses(row: ContactRow): string[] {
  return [...new Set(row.channels.filter((c) => c.type === 'email').map((c) => c.value.trim().toLowerCase()))]
}

const step = (on: string | null, s: string | null) => (on === null && s === null ? null : { on, step: s })

/**
 * "Kontaktverlauf": everything with this person, newest day first (then
 * newest first) — when they were added, every logged contact (how it went,
 * the follow-up it answered, the one it set) and mail with their email
 * addresses that the viewer may read (the mail port applies Email's rules).
 * For people only: no agent path reads anyone's mail.
 */
export async function contactHistory(
  d: ContactsDeps,
  actor: Actor,
  rawId: unknown,
  opts: { timeZone: string; mailWith: ContactMailPort },
): Promise<HistoryItem[]> {
  if (actor.kind !== 'user') throw new ContactsError('forbidden', 'A contact’s history is read by people, not the agent.')
  const dayOf = (at: Date) => dayIn(opts.timeZone, at)
  dayOf(new Date(0)) // an unknown time zone fails here, before anything is read
  const v = await viewerOf(d, actor)
  const row = await visibleRow(d, v, rawId)
  const addresses = emailAddresses(row)
  const [entries, names, mail] = await Promise.all([
    d.store.logEntries(row.id),
    d.directory.names(),
    addresses.length > 0 ? opts.mailWith(actor.userId, addresses) : Promise.resolve([]),
  ])
  const who = (kind: 'user' | 'agent', id: string) => (kind === 'agent' ? 'the agent' : (names.get(id) ?? 'a former member'))
  const items: HistoryItem[] = [
    { kind: 'added', id: row.id, day: dayOf(row.createdAt), at: row.createdAt.toISOString(), by: who(row.createdByKind, row.createdBy) },
    ...entries.map(
      (e): HistoryItem => ({
        kind: 'logged',
        id: e.id,
        day: e.on,
        at: e.createdAt.toISOString(),
        by: who(e.loggedByKind, e.loggedBy),
        note: e.note,
        answered: step(e.answeredFollowUpOn, e.answeredStep),
        next: step(e.nextFollowUpOn, e.nextStep),
      }),
    ),
    ...mail.map((m): HistoryItem => ({ ...m, kind: 'mail', day: dayOf(m.at), at: m.at.toISOString() })),
  ]
  return items.sort((a, b) => b.day.localeCompare(a.day) || b.at.localeCompare(a.at))
}

/**
 * One contact: share with the whole team (true) or make private again (false
 * — also ends its shares with people and groups): its creator, the owner,
 * admins.
 */
export async function setShared(d: ContactsDeps, actor: Actor, rawId: unknown, shared: unknown): Promise<ContactDto> {
  if (typeof shared !== 'boolean') throw new ContactsError('invalid', 'shared must be true or false')
  const v = await viewerOf(d, actor)
  const row = await visibleRow(d, v, rawId)
  if (!canManage(v, row)) {
    throw new ContactsError('forbidden', 'Only the person who added this contact, the owner and admins change who can see it.')
  }
  const hasShares = (await d.store.shares([row.id])).length > 0
  if (row.shared !== shared || (!shared && hasShares)) {
    await d.store.applySharing(
      [row.id],
      shared ? { kind: 'share', team: true, userIds: [], groupIds: [] } : { kind: 'private' },
      v.principalId,
      now(d),
    )
    await d.audit({
      type: 'contacts.sharing_changed',
      principalId: v.principalId,
      payload: { id: row.id, shared },
    })
  }
  return view(d, v, row.id)
}

// ── sharing many at once, defaults (migration 0150, Contribute 9d28020a) ──────

/** One bulk change covers at most this many contacts (the list never shows more than an import adds, times a few). */
export const SHARING_MAX = 1000

function parseIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ContactsError('invalid', 'Choose at least one contact.')
  if (raw.length > SHARING_MAX) throw new ContactsError('invalid', `Change at most ${SHARING_MAX} contacts at once.`)
  return [...new Set(raw.map((id) => parseId(id)))]
}

function parseIdList(raw: unknown, what: string): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || x.trim() === '')) {
    throw new ContactsError('invalid', `${what} must be a list of ids.`)
  }
  return [...new Set(raw.map((x: string) => x.trim()))]
}

/** Whom to share with: the whole team and/or existing members and groups (at least one). */
async function parseTargets(d: ContactsDeps, raw: unknown): Promise<Extract<SharingChange, { kind: 'share' }>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ContactsError('invalid', 'Say whom to share with.')
  const t = raw as { team?: unknown; userIds?: unknown; groupIds?: unknown }
  if (t.team !== undefined && typeof t.team !== 'boolean') throw new ContactsError('invalid', 'team must be true or false')
  const team = t.team === true
  const userIds = parseIdList(t.userIds, 'People')
  const groupIds = parseIdList(t.groupIds, 'Groups')
  if (!team && userIds.length === 0 && groupIds.length === 0) {
    throw new ContactsError('invalid', 'Choose the whole team, a person or a group to share with.')
  }
  const [names, groups] = await Promise.all([d.directory.names(), d.directory.groups()])
  const unknownUser = userIds.find((id) => !names.has(id))
  if (unknownUser !== undefined) throw new ContactsError('invalid', `No such member: ${unknownUser}`)
  const unknownGroup = groupIds.find((id) => !groups.some((g) => g.id === id))
  if (unknownGroup !== undefined) throw new ContactsError('invalid', `No such group: ${unknownGroup}`)
  return { kind: 'share', team, userIds, groupIds }
}

/**
 * Applies one change to every chosen contact the person may change (theirs;
 * every one for the owner and admins) in one go; the rest are skipped and
 * reported — seen but not theirs by name, not seen as "not found" (nothing
 * about it leaks). People only: the agent never changes who sees a contact.
 */
async function changeSharing(d: ContactsDeps, actor: Actor, rawIds: unknown, change: SharingChange): Promise<SharingResult> {
  const v = await viewerOf(d, actor)
  if (v.userId === null) throw new ContactsError('forbidden', 'Only a person changes who can see contacts.')
  const ids = parseIds(rawIds)
  const visible = await d.store.list(scopeOf(v), { ids })
  const byId = new Map(visible.map((r) => [r.id, r]))
  const changed: string[] = []
  const skipped: SharingResult['skipped'] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) skipped.push({ id, name: null, reason: 'not_found' })
    else if (!canManage(v, row)) skipped.push({ id, name: row.name, reason: 'not_yours' })
    else changed.push(id)
  }
  if (changed.length > 0) {
    await d.store.applySharing(changed, change, v.principalId, now(d))
    await d.audit({
      type: 'contacts.sharing_changed',
      principalId: v.principalId,
      payload:
        change.kind === 'private'
          ? { ids: changed, shared: false, private: true }
          : {
              ids: changed,
              team: change.team,
              userIds: [...change.userIds],
              groupIds: [...change.groupIds],
            },
    })
  }
  return { changed, skipped }
}

/** "Share with…" for many contacts: adds the whole team and/or people and groups (existing shares stay). */
export async function shareContacts(d: ContactsDeps, actor: Actor, rawIds: unknown, rawTargets: unknown): Promise<SharingResult> {
  return changeSharing(d, actor, rawIds, await parseTargets(d, rawTargets))
}

/** "Make private" for many contacts: no whole-team share and no people or group shares left. */
export async function makeContactsPrivate(d: ContactsDeps, actor: Actor, rawIds: unknown): Promise<SharingResult> {
  return changeSharing(d, actor, rawIds, { kind: 'private' })
}

/** The members and groups a person can share with, by name. */
export async function shareChoices(d: ContactsDeps, actor: Actor): Promise<ShareChoices> {
  await viewerOf(d, actor)
  const [names, groups] = await Promise.all([d.directory.names(), d.directory.groups()])
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  return {
    people: [...names].map(([id, name]) => ({ id, name })).sort(byName),
    groups: groups.map((g) => ({ id: g.id, name: g.name })).sort(byName),
  }
}

/**
 * Precedence (decision 2026-11-18): the person's own choice, else the
 * company default the owner or an admin set, else private. The agent on its
 * own has no own choice: the company default.
 */
async function defaultsOf(d: ContactsDeps, v: Viewer): Promise<VisibilityDefaults> {
  const stored = await d.store.defaults(v.userId)
  return { ...stored, effective: stored.person ?? stored.company ?? 'private' }
}

export async function visibilityDefaults(d: ContactsDeps, actor: Actor): Promise<VisibilityDefaults> {
  return defaultsOf(d, await viewerOf(d, actor))
}

/** Contacts settings: the defaults, and whether this person may set the company's (the owner and admins). */
export async function contactSettings(d: ContactsDeps, actor: Actor): Promise<{ defaults: VisibilityDefaults; canSetCompany: boolean }> {
  const v = await viewerOf(d, actor)
  return { defaults: await defaultsOf(d, v), canSetCompany: v.userId !== null && v.all }
}

/** private | team | '' / null (follow the company default). */
function parseVisibilityChoice(raw: unknown): ContactVisibility | null {
  if (raw === null || raw === '' || raw === 'company') return null
  if (typeof raw === 'string' && (CONTACT_VISIBILITIES as readonly string[]).includes(raw)) return raw as ContactVisibility
  throw new ContactsError('invalid', `A default is one of ${CONTACT_VISIBILITIES.join(', ')} (or the company's).`)
}

/** A person's own default for new contacts (null = follow the company's). */
export async function setMyDefaultVisibility(d: ContactsDeps, actor: Actor, raw: unknown): Promise<VisibilityDefaults> {
  const v = await viewerOf(d, actor)
  if (v.userId === null) throw new ContactsError('forbidden', 'A person sets their own default, not the agent.')
  const value = parseVisibilityChoice(raw)
  await d.store.setPersonDefault(v.userId, value)
  await d.audit({
    type: 'contacts.default_visibility_set',
    principalId: v.principalId,
    payload: { scope: 'person', visibility: value },
  })
  return defaultsOf(d, v)
}

/** The company-wide default for new contacts (null = private): the owner and admins only. */
export async function setCompanyDefaultVisibility(d: ContactsDeps, actor: Actor, raw: unknown): Promise<VisibilityDefaults> {
  const v = await viewerOf(d, actor)
  if (v.userId === null || !v.all) throw new ContactsError('forbidden', 'Only the company owner and admins set the company default.')
  const value = parseVisibilityChoice(raw)
  await d.store.setCompanyDefault(value, v.principalId)
  await d.audit({
    type: 'contacts.default_visibility_set',
    principalId: v.principalId,
    payload: { scope: 'company', visibility: value },
  })
  return defaultsOf(d, v)
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

// ── import (vCard, CSV) ───────────────────────────────────────────────────────

const CANDIDATE_KEYS = ['name', 'organisation', 'title', 'channels', 'metHow', 'whyRelevant', 'tags'] as const

/** The request's candidates: a list of 1…IMPORT_MAX objects with only the import's fields (else the request is refused). */
function candidatesOf(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) throw new ContactsError('invalid', 'Expected a list of contacts to import.')
  if (raw.length === 0) throw new ContactsError('invalid', 'There is nobody to import in that file.')
  if (raw.length > IMPORT_MAX) throw new ContactsError('invalid', `One import adds at most ${IMPORT_MAX} contacts; split the file.`)
  return raw.map((c: unknown, i) => {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) throw new ContactsError('invalid', `Row ${i + 1} is not a contact.`)
    const extra = Object.keys(c).filter((k) => !(CANDIDATE_KEYS as readonly string[]).includes(k))
    if (extra.length > 0) throw new ContactsError('invalid', `Row ${i + 1} has fields an import doesn’t set: ${extra.join(', ')}.`)
    return c as Record<string, unknown>
  })
}

/** One candidate checked like a typed contact (the same limits and tag rules). */
function checkedCandidate(c: Record<string, unknown>): ImportCandidate {
  const name = parseName(c.name)
  const f = parseFields({ ...c, name })
  return {
    name,
    organisation: f.organisation ?? null,
    title: f.title ?? null,
    channels: f.channels ?? [],
    metHow: f.metHow ?? null,
    whyRelevant: f.whyRelevant ?? null,
    tags: f.tags ?? [],
  }
}

const emailsOf = (channels: readonly Channel[]) => channels.filter((c) => c.type === 'email').map((c) => c.value.trim().toLowerCase())

async function preview(d: ContactsDeps, v: Viewer, raw: unknown): Promise<ImportPreview> {
  const candidates = candidatesOf(raw)
  // Known = a contact this person sees (someone else's private contact is not theirs to know about).
  const known = new Map<string, { id: string; name: string }>()
  for (const row of await d.store.list(scopeOf(v), {})) {
    for (const email of emailsOf(row.channels)) if (!known.has(email)) known.set(email, { id: row.id, name: row.name })
  }
  const inFile = new Set<string>()
  const rows = candidates.map((c, index): ImportPreviewRow => {
    let contact: ImportCandidate
    try {
      contact = checkedCandidate(c)
    } catch (err) {
      if (!(err instanceof ContactsError)) throw err
      return { index, status: 'invalid', name: typeof c.name === 'string' ? c.name.trim() : '', error: err.message }
    }
    const emails = emailsOf(contact.channels)
    const dup = emails.find((e) => known.has(e) || inFile.has(e))
    for (const e of emails) inFile.add(e)
    if (dup !== undefined) return { index, status: 'duplicate', contact, email: dup, existing: known.get(dup) ?? null }
    return { index, status: 'new', contact }
  })
  const count = (status: ImportPreviewRow['status']) => rows.filter((r) => r.status === status).length
  return { rows, counts: { new: count('new'), duplicate: count('duplicate'), invalid: count('invalid') } }
}

async function importer(d: ContactsDeps, actor: Actor): Promise<Viewer & { userId: string }> {
  const v = await viewerOf(d, actor)
  if (v.userId === null) throw new ContactsError('forbidden', 'A person imports contacts, not the agent.')
  return { ...v, userId: v.userId }
}

/**
 * What an import would do, row by row — nothing is saved: new (importable),
 * already known by email (to you: yours, shared ones, and every one for the
 * owner and admins — or an earlier row of the file), or not importable as it
 * is (with the reason).
 */
export async function previewImport(d: ContactsDeps, actor: Actor, raw: unknown): Promise<ImportPreview> {
  return preview(d, await importer(d, actor), raw)
}

/**
 * The confirmed import: the rows are checked again; one that is not
 * importable stops it (nothing added); duplicates are skipped and reported,
 * the known contact is never changed; the new ones are added together, as
 * the importer chose (true = whole team) or, left out, as their default.
 */
export async function importContacts(
  d: ContactsDeps,
  actor: Actor,
  raw: unknown,
  opts: { shared?: boolean } = {},
): Promise<{ created: ContactDto[]; skipped: ImportPreviewRow[] }> {
  const v = await importer(d, actor)
  if (opts.shared !== undefined && typeof opts.shared !== 'boolean') throw new ContactsError('invalid', 'shared must be true or false')
  const shared = opts.shared ?? (await defaultsOf(d, v)).effective === 'team'
  const { rows } = await preview(d, v, raw)
  const invalid = rows.find((r) => r.status === 'invalid')
  if (invalid && invalid.status === 'invalid') {
    throw new ContactsError('invalid', `Row ${invalid.index + 1}${invalid.name ? ` (${invalid.name})` : ''}: ${invalid.error}`)
  }
  const skipped = rows.filter((r) => r.status === 'duplicate')
  const at = now(d)
  const created: ContactRow[] = rows.flatMap((r) =>
    r.status === 'new'
      ? [
          {
            id: newId(d),
            ...r.contact,
            lastContactedOn: null,
            nextFollowUpOn: null,
            nextStep: null,
            stage: 'inbox' as const,
            ownerId: v.userId,
            via: null,
            latestStatus: null,
            waitingSince: null,
            createdBy: v.userId,
            createdByKind: 'user' as const,
            shared,
            createdAt: at,
            updatedAt: at,
          },
        ]
      : [],
  )
  if (created.length === 0) return { created: [], skipped }
  await d.store.insertMany(created)
  await d.audit({
    type: 'contacts.imported',
    principalId: v.principalId,
    payload: { ids: created.map((r) => r.id), shared, skipped: skipped.length },
  })
  return { created: await dtos(d, v, created), skipped }
}
