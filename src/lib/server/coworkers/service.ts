import { randomUUID } from 'node:crypto'
import { isAdminRole, type MemberRole } from '$lib/server/auth/roles'
import type { UserKind } from '$lib/server/db/auth.schema'
import { assertPoolModel, ModelNotInPoolError } from '$lib/server/llm/model-pool'
import { coworkerTemplate, type CoworkerTemplate } from './templates'

/**
 * AI co-workers and the org chart (plan/phase-ai-coworkers.md §3, §4, C1).
 *
 * A co-worker is a `user` row with kind 'coworker' (always company role
 * member, never signs in) plus its role card (coworker_profile). The org chart
 * (org_position) is one table for people and co-workers alike: title,
 * accountabilities, reports-to. Every co-worker resolves to an ACCOUNTABLE
 * HUMAN — the nearest person up its reports-to chain, else the owner — whom its
 * approval-gated calls and proactive results go to (C3, C6).
 *
 * Writes are admin-only (owner and admins, or the agent with admin rights
 * behind the approval gate); a member edits only their own title and
 * accountabilities. A co-worker writes nothing here. Removing a co-worker keeps
 * its user row so nothing it wrote vanishes: it is switched off for good,
 * leaves the member list and the chart, and its reports move up to its manager.
 */

export const COWORKER_EMAIL_DOMAIN = 'coworker.invalid'

export const NAME_MAX = 80
export const TITLE_MAX = 120
export const LENS_MAX = 4000
export const ACCOUNTABILITY_MAX = 300
export const ACCOUNTABILITIES_MAX = 8
/** The highest daily cap a co-worker may carry (USD per UTC day): a guard against a typo, not a budget. */
export const DAILY_CAP_MAX_USD = 1000

export type OrgMember = {
  id: string
  name: string
  email: string
  role: MemberRole
  kind: UserKind
  createdAt: Date
}

export type OrgPositionRow = {
  userId: string
  title: string | null
  reportsToUserId: string | null
  accountabilities: string[]
  updatedAt: Date
  updatedBy: string
}

export type CoworkerProfileRow = {
  userId: string
  slug: string
  lens: string
  modelId: string
  enabled: boolean
  dailyCapUsd: number
  templateId: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
  removedAt: Date | null
  removedBy: string | null
}

export type NewCoworker = {
  user: { id: string; name: string; email: string; createdAt: Date }
  profile: CoworkerProfileRow
  position: OrgPositionRow
}

export type CoworkerPatch = {
  name?: string
  profile?: Partial<Pick<CoworkerProfileRow, 'lens' | 'modelId' | 'dailyCapUsd' | 'enabled'>> & { updatedAt: Date }
  position?: OrgPositionRow
}

export type CoworkerStore = {
  /** Active members: production people and co-workers that are not removed. */
  listMembers(): Promise<OrgMember[]>
  listPositions(): Promise<OrgPositionRow[]>
  /** Every co-worker profile, removed ones included. */
  listProfiles(): Promise<CoworkerProfileRow[]>
  /** The user row behind a co-worker, removed ones included (name, email). */
  coworkerUser(userId: string): Promise<{ id: string; name: string; email: string } | null>
  slugTaken(slug: string): Promise<boolean>
  /** User row (kind coworker, role member, no account) + profile + org position, together. */
  insertCoworker(input: NewCoworker): Promise<void>
  updateCoworker(userId: string, patch: CoworkerPatch): Promise<void>
  upsertPosition(row: OrgPositionRow): Promise<void>
  /** Marks the co-worker removed (and off) and moves its direct reports to `reparentTo`. */
  markRemoved(userId: string, at: Date, by: string, reparentTo: string | null): Promise<void>
  /**
   * Runs `fn` as one transaction over a store that sees the org chart
   * serialized against every other org write (cycle checks stay true).
   */
  transaction<T>(fn: (store: CoworkerStore) => Promise<T>): Promise<T>
}

export type CoworkerDeps = {
  store: CoworkerStore
  now?: () => Date
  newId?: () => string
}

export class CoworkerError extends Error {
  constructor(
    readonly code:
      | 'forbidden'
      | 'not_found'
      | 'invalid_input'
      | 'invalid_model'
      | 'org_cycle'
      | 'removed'
      | 'no_owner',
    message: string,
  ) {
    super(message)
    this.name = 'CoworkerError'
  }
}

/** Who is acting: a person with their stored role, a co-worker, or the agent (admin rights, behind the approval gate). */
export type CoworkerActor = { id: string; role: MemberRole | null; kind: 'person' | 'coworker' | 'agent' }

function assertAdmin(actor: CoworkerActor): void {
  if (actor.kind === 'coworker' || !isAdminRole(actor.role)) {
    throw new CoworkerError('forbidden', 'Only the owner or an admin can manage AI co-workers and the org chart.')
  }
}

/** The agent id a co-worker's turns run as (coworkerPrincipal's agentId). */
export function coworkerAgentId(userId: string): string {
  return `coworker:${userId}`
}

/** A co-worker's never-mailed address: `<slug>.<first 8 of id>@coworker.invalid` (reserved TLD). */
export function coworkerEmail(slug: string, userId: string): string {
  return `${slug}.${userId.slice(0, 8)}@${COWORKER_EMAIL_DOMAIN}`
}

/** URL-safe handle from a name: ASCII letters and digits joined by "-" (formatting, not meaning). */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return base || 'coworker'
}

// --- views -------------------------------------------------------------------

export type AccountableHuman = {
  id: string
  name: string
  /** chain = the nearest person up the reports-to chain; owner = nobody human above, so the owner. */
  reason: 'chain' | 'owner'
}

export type CoworkerView = {
  id: string
  name: string
  email: string
  slug: string
  title: string | null
  accountabilities: string[]
  lens: string
  modelId: string
  enabled: boolean
  dailyCapUsd: number
  templateId: string | null
  reportsToUserId: string | null
  /** Null only for a removed co-worker (it is out of the chart). */
  accountableHuman: AccountableHuman | null
  agentId: string
  createdBy: string
  createdAt: string
  updatedAt: string
  removedAt: string | null
}

export type OrgChartEntry = {
  id: string
  name: string
  kind: UserKind
  role: MemberRole
  title: string | null
  accountabilities: string[]
  reportsToUserId: string | null
  /** Co-workers only: the person they answer to (nearest human up the chain, else the owner). */
  accountableHuman: AccountableHuman | null
  /** Co-workers only: whether it currently works. */
  enabled: boolean | null
}

type Chart = {
  members: Map<string, OrgMember>
  positions: Map<string, OrgPositionRow>
  profiles: Map<string, CoworkerProfileRow>
}

async function loadChart(store: CoworkerStore): Promise<Chart> {
  const [members, positions, profiles] = await Promise.all([store.listMembers(), store.listPositions(), store.listProfiles()])
  return {
    members: new Map(members.map((m) => [m.id, m])),
    positions: new Map(positions.map((p) => [p.userId, p])),
    profiles: new Map(profiles.map((p) => [p.userId, p])),
  }
}

/** The reports-to chain above `userId` (nearest first). Fails loud on a cycle in stored data. */
function chainAbove(chart: Chart, userId: string): string[] {
  const out: string[] = []
  const seen = new Set([userId])
  let next = chart.positions.get(userId)?.reportsToUserId ?? null
  while (next) {
    if (seen.has(next)) throw new CoworkerError('org_cycle', `The org chart has a reporting cycle through ${next}.`)
    seen.add(next)
    out.push(next)
    next = chart.positions.get(next)?.reportsToUserId ?? null
  }
  return out
}

function ownerOf(chart: Chart): OrgMember {
  const owner = [...chart.members.values()].find((m) => m.role === 'owner')
  if (!owner) throw new CoworkerError('no_owner', 'The company has no owner, so a co-worker has nobody to answer to.')
  return owner
}

function accountableIn(chart: Chart, coworkerId: string): AccountableHuman {
  for (const id of chainAbove(chart, coworkerId)) {
    const m = chart.members.get(id)
    if (m && m.kind === 'human') return { id: m.id, name: m.name, reason: 'chain' }
  }
  const owner = ownerOf(chart)
  return { id: owner.id, name: owner.name, reason: 'owner' }
}

function coworkerView(chart: Chart, profile: CoworkerProfileRow, user: { id: string; name: string; email: string }): CoworkerView {
  const position = chart.positions.get(profile.userId)
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    slug: profile.slug,
    title: position?.title ?? null,
    accountabilities: position?.accountabilities ?? [],
    lens: profile.lens,
    modelId: profile.modelId,
    enabled: profile.enabled,
    dailyCapUsd: profile.dailyCapUsd,
    templateId: profile.templateId,
    reportsToUserId: position?.reportsToUserId ?? null,
    accountableHuman: profile.removedAt ? null : accountableIn(chart, profile.userId),
    agentId: coworkerAgentId(profile.userId),
    createdBy: profile.createdBy,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
    removedAt: profile.removedAt?.toISOString() ?? null,
  }
}

async function viewOf(store: CoworkerStore, chart: Chart, userId: string): Promise<CoworkerView> {
  const profile = chart.profiles.get(userId)
  const user = profile ? (chart.members.get(userId) ?? (await store.coworkerUser(userId))) : null
  if (!profile || !user) throw new CoworkerError('not_found', `No AI co-worker ${userId}.`)
  return coworkerView(chart, profile, user)
}

// --- reads -------------------------------------------------------------------

/** The company's co-workers (removed ones left out), oldest first. */
export async function listCoworkers(store: CoworkerStore): Promise<CoworkerView[]> {
  const chart = await loadChart(store)
  return [...chart.profiles.values()]
    .filter((p) => !p.removedAt)
    .flatMap((p) => {
      const user = chart.members.get(p.userId)
      return user ? [coworkerView(chart, p, user)] : []
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** The co-workers that work right now (enabled, not removed): what C3's runtime registers. */
export async function listEnabledCoworkers(store: CoworkerStore): Promise<CoworkerView[]> {
  return (await listCoworkers(store)).filter((c) => c.enabled)
}

/** One co-worker, a removed one included. */
export async function getCoworker(store: CoworkerStore, userId: string): Promise<CoworkerView> {
  return viewOf(store, await loadChart(store), userId)
}

/** The person a co-worker answers to: the nearest human up its reports-to chain, else the owner. */
export async function accountableHumanFor(store: CoworkerStore, coworkerUserId: string): Promise<AccountableHuman> {
  const chart = await loadChart(store)
  const profile = chart.profiles.get(coworkerUserId)
  if (!profile) throw new CoworkerError('not_found', `No AI co-worker ${coworkerUserId}.`)
  if (profile.removedAt) throw new CoworkerError('removed', `The AI co-worker ${coworkerUserId} was removed.`)
  return accountableIn(chart, coworkerUserId)
}

/** Everyone in the company — people and co-workers — with their seat in the org chart. */
export async function orgChart(store: CoworkerStore): Promise<{ people: OrgChartEntry[] }> {
  const chart = await loadChart(store)
  const people = [...chart.members.values()]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((m): OrgChartEntry => {
      const position = chart.positions.get(m.id)
      const profile = m.kind === 'coworker' ? chart.profiles.get(m.id) : undefined
      // A manager who left (a removed co-worker) is not shown as anyone's manager.
      const reportsTo = position?.reportsToUserId ?? null
      return {
        id: m.id,
        name: m.name,
        kind: m.kind,
        role: m.role,
        title: position?.title ?? null,
        accountabilities: position?.accountabilities ?? [],
        reportsToUserId: reportsTo && chart.members.has(reportsTo) ? reportsTo : null,
        accountableHuman: m.kind === 'coworker' ? accountableIn(chart, m.id) : null,
        enabled: profile ? profile.enabled : null,
      }
    })
  return { people }
}

// --- validation --------------------------------------------------------------

function cleanText(value: string, what: string, max: number): string {
  const v = value.trim()
  if (!v || v.length > max) throw new CoworkerError('invalid_input', `${what} must be 1 to ${max} characters.`)
  return v
}

function cleanAccountabilities(values: string[], min: number): string[] {
  const out = values.map((v) => v.trim()).filter((v) => v.length > 0)
  if (out.length < min || out.length > ACCOUNTABILITIES_MAX) {
    throw new CoworkerError('invalid_input', `Give ${min} to ${ACCOUNTABILITIES_MAX} accountabilities.`)
  }
  for (const a of out) {
    if (a.length > ACCOUNTABILITY_MAX) throw new CoworkerError('invalid_input', `An accountability is at most ${ACCOUNTABILITY_MAX} characters.`)
  }
  return out
}

function chatModel(modelId: string): string {
  try {
    return assertPoolModel('chat', modelId.trim())
  } catch (err) {
    if (err instanceof ModelNotInPoolError) throw new CoworkerError('invalid_model', err.message)
    throw err
  }
}

function dailyCap(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > DAILY_CAP_MAX_USD) {
    throw new CoworkerError('invalid_input', `The daily cap must be more than $0 and at most $${DAILY_CAP_MAX_USD}.`)
  }
  return value
}

/** Refuses self-reporting, an unknown manager and any change that would close a reporting cycle. */
function assertManager(chart: Chart, userId: string, managerId: string | null): void {
  if (managerId === null) return
  if (managerId === userId) throw new CoworkerError('org_cycle', 'Nobody can report to themselves.')
  if (!chart.members.has(managerId)) throw new CoworkerError('not_found', `No member ${managerId} to report to.`)
  if (chainAbove(chart, managerId).includes(userId)) {
    throw new CoworkerError('org_cycle', `That would make a reporting cycle: ${managerId} already reports, through the chain, to ${userId}.`)
  }
}

// --- writes ------------------------------------------------------------------

export type CreateCoworkerInput = {
  templateId?: string
  name?: string
  title?: string
  lens?: string
  accountabilities?: string[]
  modelId?: string
  reportsToUserId?: string | null
  dailyCapUsd?: number
}

function fromTemplate(input: CreateCoworkerInput): CoworkerTemplate | undefined {
  if (input.templateId === undefined) return undefined
  const t = coworkerTemplate(input.templateId)
  if (!t) throw new CoworkerError('invalid_input', `No co-worker template "${input.templateId}" (see coworkers.templates).`)
  return t
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new CoworkerError('invalid_input', `Give ${what}, or start from a template (template_id, see coworkers.templates).`)
  }
  return value
}

async function freeSlug(store: CoworkerStore, name: string): Promise<string> {
  const base = slugify(name)
  for (let n = 1; n < 1000; n++) {
    const slug = n === 1 ? base : `${base}-${n}`
    if (!(await store.slugTaken(slug))) return slug
  }
  throw new CoworkerError('invalid_input', `Too many co-workers are called ${name}.`)
}

/** Creates the co-worker: user row (kind coworker, member, no sign-in) + role card + seat in the org chart, in one transaction. */
export async function createCoworker(actor: CoworkerActor, input: CreateCoworkerInput, deps: CoworkerDeps): Promise<CoworkerView> {
  assertAdmin(actor)
  const template = fromTemplate(input)
  const title = cleanText(required(input.title ?? template?.title, 'a title'), 'The title', TITLE_MAX)
  const name = cleanText(input.name ?? title, 'The name', NAME_MAX)
  const lens = cleanText(required(input.lens ?? template?.lens, 'a lens (the role prompt)'), 'The lens', LENS_MAX)
  const accountabilities = cleanAccountabilities(required(input.accountabilities ?? template?.accountabilities, 'accountabilities'), 1)
  const modelId = chatModel(required(input.modelId ?? template?.suggestedModelId, 'a model (model_id)'))
  const capUsd = dailyCap(required(input.dailyCapUsd ?? template?.suggestedDailyCapUsd, 'a daily cap (daily_cap_usd)'))
  const now = deps.now?.() ?? new Date()
  const id = deps.newId?.() ?? randomUUID().replaceAll('-', '')
  return deps.store.transaction(async (store) => {
    const chart = await loadChart(store)
    const reportsTo = input.reportsToUserId ?? null
    assertManager(chart, id, reportsTo)
    const slug = await freeSlug(store, name)
    await store.insertCoworker({
      user: { id, name, email: coworkerEmail(slug, id), createdAt: now },
      profile: {
        userId: id,
        slug,
        lens,
        modelId,
        enabled: true,
        dailyCapUsd: capUsd,
        templateId: template?.id ?? null,
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
        removedAt: null,
        removedBy: null,
      },
      position: { userId: id, title, reportsToUserId: reportsTo, accountabilities, updatedAt: now, updatedBy: actor.id },
    })
    return getCoworker(store, id)
  })
}

export type UpdateCoworkerInput = {
  userId: string
  name?: string
  title?: string
  lens?: string
  accountabilities?: string[]
  modelId?: string
  reportsToUserId?: string | null
  dailyCapUsd?: number
}

async function liveProfile(chart: Chart, userId: string): Promise<CoworkerProfileRow> {
  const profile = chart.profiles.get(userId)
  if (!profile) throw new CoworkerError('not_found', `No AI co-worker ${userId}.`)
  if (profile.removedAt) throw new CoworkerError('removed', `The AI co-worker ${userId} was removed; it can't be changed.`)
  return profile
}

/** Changes a co-worker's name, role card, model, cap or seat (only the fields given). */
export async function updateCoworker(actor: CoworkerActor, input: UpdateCoworkerInput, deps: CoworkerDeps): Promise<CoworkerView> {
  assertAdmin(actor)
  const now = deps.now?.() ?? new Date()
  return deps.store.transaction(async (store) => {
    const chart = await loadChart(store)
    await liveProfile(chart, input.userId)
    const position = chart.positions.get(input.userId)
    const patch: CoworkerPatch = { profile: { updatedAt: now } }
    if (input.name !== undefined) patch.name = cleanText(input.name, 'The name', NAME_MAX)
    if (input.lens !== undefined) patch.profile!.lens = cleanText(input.lens, 'The lens', LENS_MAX)
    if (input.modelId !== undefined) patch.profile!.modelId = chatModel(input.modelId)
    if (input.dailyCapUsd !== undefined) patch.profile!.dailyCapUsd = dailyCap(input.dailyCapUsd)
    if (input.title !== undefined || input.accountabilities !== undefined || input.reportsToUserId !== undefined) {
      const reportsTo = input.reportsToUserId === undefined ? (position?.reportsToUserId ?? null) : input.reportsToUserId
      if (input.reportsToUserId !== undefined) assertManager(chart, input.userId, reportsTo)
      patch.position = {
        userId: input.userId,
        title: input.title === undefined ? (position?.title ?? null) : cleanText(input.title, 'The title', TITLE_MAX),
        accountabilities:
          input.accountabilities === undefined ? (position?.accountabilities ?? []) : cleanAccountabilities(input.accountabilities, 1),
        reportsToUserId: reportsTo,
        updatedAt: now,
        updatedBy: actor.id,
      }
    }
    await store.updateCoworker(input.userId, patch)
    return getCoworker(store, input.userId)
  })
}

/** Switches a co-worker on (it works) or off (it does nothing until switched on again). */
export async function setCoworkerEnabled(
  actor: CoworkerActor,
  input: { userId: string; enabled: boolean },
  deps: CoworkerDeps,
): Promise<CoworkerView> {
  assertAdmin(actor)
  const now = deps.now?.() ?? new Date()
  return deps.store.transaction(async (store) => {
    await liveProfile(await loadChart(store), input.userId)
    await store.updateCoworker(input.userId, { profile: { enabled: input.enabled, updatedAt: now } })
    return getCoworker(store, input.userId)
  })
}

/**
 * Removes a co-worker for good, keeping everything it wrote: its user row stays
 * (messages, thoughts and the cost ledger keep their author), it is switched
 * off, it leaves the member list and the org chart, and whoever reported to it
 * now reports to its manager.
 */
export async function removeCoworker(actor: CoworkerActor, input: { userId: string }, deps: CoworkerDeps): Promise<CoworkerView> {
  assertAdmin(actor)
  const now = deps.now?.() ?? new Date()
  return deps.store.transaction(async (store) => {
    const chart = await loadChart(store)
    await liveProfile(chart, input.userId)
    const manager = chart.positions.get(input.userId)?.reportsToUserId ?? null
    await store.markRemoved(input.userId, now, actor.id, manager)
    return getCoworker(store, input.userId)
  })
}

export type SetOrgPositionInput = {
  userId: string
  title?: string | null
  accountabilities?: string[]
  /** Admins only. */
  reportsToUserId?: string | null
}

/** Sets a seat in the org chart. An admin sets anyone's; a member only their own title and accountabilities. */
export async function setOrgPosition(actor: CoworkerActor, input: SetOrgPositionInput, deps: CoworkerDeps): Promise<OrgChartEntry> {
  if (actor.kind === 'coworker') {
    throw new CoworkerError('forbidden', 'A co-worker’s seat in the org chart is set by the owner or an admin.')
  }
  const admin = isAdminRole(actor.role)
  if (!admin) {
    if (input.userId !== actor.id) throw new CoworkerError('forbidden', 'You can only change your own title and accountabilities.')
    if (input.reportsToUserId !== undefined) {
      throw new CoworkerError('forbidden', 'Only the owner or an admin decides who reports to whom.')
    }
  }
  const now = deps.now?.() ?? new Date()
  return deps.store.transaction(async (store) => {
    const chart = await loadChart(store)
    if (!chart.members.has(input.userId)) throw new CoworkerError('not_found', `No member ${input.userId}.`)
    const current = chart.positions.get(input.userId)
    const reportsTo = input.reportsToUserId === undefined ? (current?.reportsToUserId ?? null) : input.reportsToUserId
    if (input.reportsToUserId !== undefined) assertManager(chart, input.userId, reportsTo)
    const isCoworker = chart.members.get(input.userId)!.kind === 'coworker'
    const title =
      input.title === undefined
        ? (current?.title ?? null)
        : input.title === null
          ? null
          : cleanText(input.title, 'The title', TITLE_MAX)
    if (isCoworker && title === null) throw new CoworkerError('invalid_input', 'A co-worker always has a title.')
    await store.upsertPosition({
      userId: input.userId,
      title,
      reportsToUserId: reportsTo,
      accountabilities:
        input.accountabilities === undefined
          ? (current?.accountabilities ?? [])
          : cleanAccountabilities(input.accountabilities, isCoworker ? 1 : 0),
      updatedAt: now,
      updatedBy: actor.id,
    })
    const entry = (await orgChart(store)).people.find((p) => p.id === input.userId)
    if (!entry) throw new CoworkerError('not_found', `No member ${input.userId}.`)
    return entry
  })
}
