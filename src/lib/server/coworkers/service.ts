import { randomUUID } from 'node:crypto'
import {
  coworkerAvatarPresetUrl,
  isCoworkerAvatarPresetId,
  isCoworkerAvatarPresetUrl,
  type CoworkerAvatarPresetId,
} from '$lib/coworkers/avatar-presets'
import { coworkerEmail } from '$lib/coworkers/handle'
import { avatarUrl, isAvatarSha } from '$lib/profile/profile'
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

export { COWORKER_EMAIL_DOMAIN, coworkerEmail } from '$lib/coworkers/handle'

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
  image?: string | null
  avatarSha256?: string | null
}

export type OrgPositionRow = {
  userId: string
  title: string | null
  reportsToUserId: string | null
  reportsToUserIds: string[]
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
  user: { id: string; name: string; email: string; image: string | null; avatarSha256: string | null; createdAt: Date }
  profile: CoworkerProfileRow
  position: OrgPositionRow
}

export type CoworkerPatch = {
  name?: string
  avatar?: { image: string | null; avatarSha256: string | null }
  profile?: Partial<Pick<CoworkerProfileRow, 'lens' | 'modelId' | 'dailyCapUsd' | 'enabled'>> & { updatedAt: Date }
  position?: OrgPositionRow
}

export type CoworkerStore = {
  /** Active members: production people and co-workers that are not removed. */
  listMembers(): Promise<OrgMember[]>
  listPositions(): Promise<OrgPositionRow[]>
  /** Every co-worker profile, removed ones included. */
  listProfiles(): Promise<CoworkerProfileRow[]>
  /** The user row behind a co-worker, removed ones included (name, email, avatar). */
  coworkerUser(userId: string): Promise<{ id: string; name: string; email: string; image?: string | null; avatarSha256?: string | null } | null>
  slugTaken(slug: string): Promise<boolean>
  /** User row (kind coworker, role member, no account) + profile + org position, together. */
  insertCoworker(input: NewCoworker): Promise<void>
  updateCoworker(userId: string, patch: CoworkerPatch): Promise<void>
  upsertPosition(row: OrgPositionRow): Promise<void>
  /** Marks the co-worker removed (and off) and moves its direct reports to `reparentTo`. */
  markRemoved(userId: string, at: Date, by: string, reparentTo: string[]): Promise<void>
  /**
   * Runs `fn` as one transaction over a store that sees the org chart
   * serialized against every other org write (cycle checks stay true).
   */
  transaction<T>(fn: (store: CoworkerStore) => Promise<T>): Promise<T>
}

export type CoworkerDeps = {
  store: CoworkerStore
  avatarExists?: (sha256: string) => Promise<boolean>
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
      | 'no_owner'
      | 'not_member',
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
  return `coworker-${userId}`
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
  image: string | null
  title: string | null
  accountabilities: string[]
  lens: string
  modelId: string
  enabled: boolean
  dailyCapUsd: number
  templateId: string | null
  reportsToUserId: string | null
  reportsToUserIds: string[]
  /** Null only for a removed co-worker (it is out of the chart). */
  accountableHuman: AccountableHuman | null
  accountableHumans: AccountableHuman[]
  agentId: string
  createdBy: string
  createdAt: string
  updatedAt: string
  removedAt: string | null
}

export type OrgChartEntry = {
  id: string
  name: string
  image: string | null
  kind: UserKind
  role: MemberRole
  title: string | null
  accountabilities: string[]
  reportsToUserId: string | null
  reportsToUserIds: string[]
  /** Co-workers only: the person they answer to (nearest human up the chain, else the owner). */
  accountableHuman: AccountableHuman | null
  /** Co-workers only: all nearest humans across reporting branches, else [owner]. */
  accountableHumans: AccountableHuman[]
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

function memberImageOf(u: { image?: string | null; avatarSha256?: string | null }): string | null {
  if (isAvatarSha(u.avatarSha256)) return avatarUrl(u.avatarSha256)
  if (isCoworkerAvatarPresetUrl(u.image)) return u.image
  return null
}

function positionManagers(pos: OrgPositionRow | undefined): string[] {
  if (!pos) return []
  return pos.reportsToUserIds.length > 0 ? pos.reportsToUserIds : pos.reportsToUserId ? [pos.reportsToUserId] : []
}

/** Every reachable manager above `userId` (DAG-safe). Fails loud on a cycle in stored data. */
function ancestorsOf(chart: Chart, userId: string): Set<string> {
  const ancestors = new Set<string>()
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const dfs = (current: string, isRoot: boolean): void => {
    visiting.add(current)
    for (const next of positionManagers(chart.positions.get(current))) {
      if (visiting.has(next)) {
        throw new CoworkerError('org_cycle', `The org chart has a reporting cycle through ${next}.`)
      }
      ancestors.add(next)
      if (!visited.has(next)) dfs(next, false)
    }
    visiting.delete(current)
    if (!isRoot) visited.add(current)
  }

  dfs(userId, true)
  return ancestors
}

function ownerOf(chart: Chart): OrgMember {
  const owner = [...chart.members.values()].find((m) => m.role === 'owner')
  if (!owner) throw new CoworkerError('no_owner', 'The company has no owner, so a co-worker has nobody to answer to.')
  return owner
}

function accountableHumansIn(chart: Chart, coworkerId: string): AccountableHuman[] {
  ancestorsOf(chart, coworkerId)
  const queue = [...positionManagers(chart.positions.get(coworkerId))]
  const seen = new Set<string>([coworkerId])
  const humans: AccountableHuman[] = []
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    if (seen.has(id)) continue
    seen.add(id)
    const m = chart.members.get(id)
    if (!m) continue
    if (m.kind === 'human') {
      humans.push({ id: m.id, name: m.name, reason: 'chain' })
      // Nearest person on this reporting branch: stop traversing above a human.
      continue
    }
    for (const next of positionManagers(chart.positions.get(id))) {
      if (!seen.has(next)) queue.push(next)
    }
  }
  if (humans.length > 0) return humans
  const owner = ownerOf(chart)
  return [{ id: owner.id, name: owner.name, reason: 'owner' }]
}

function coworkerView(
  chart: Chart,
  profile: CoworkerProfileRow,
  user: { id: string; name: string; email: string; image?: string | null; avatarSha256?: string | null },
): CoworkerView {
  const position = chart.positions.get(profile.userId)
  const reportsToUserIds = positionManagers(position).filter((id) => chart.members.has(id))
  const accountableHumans = profile.removedAt ? [] : accountableHumansIn(chart, profile.userId)
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    slug: profile.slug,
    image: memberImageOf(user),
    title: position?.title ?? null,
    accountabilities: position?.accountabilities ?? [],
    lens: profile.lens,
    modelId: profile.modelId,
    enabled: profile.enabled,
    dailyCapUsd: profile.dailyCapUsd,
    templateId: profile.templateId,
    reportsToUserId: reportsToUserIds[0] ?? null,
    reportsToUserIds,
    accountableHuman: accountableHumans[0] ?? null,
    accountableHumans,
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

/** The person(s) a co-worker answers to: the nearest human(s) up each reporting branch, else [owner]. */
export async function accountableHumansFor(store: CoworkerStore, coworkerUserId: string): Promise<AccountableHuman[]> {
  const chart = await loadChart(store)
  const profile = chart.profiles.get(coworkerUserId)
  if (!profile) throw new CoworkerError('not_found', `No AI co-worker ${coworkerUserId}.`)
  if (profile.removedAt) throw new CoworkerError('removed', `The AI co-worker ${coworkerUserId} was removed.`)
  return accountableHumansIn(chart, coworkerUserId)
}

/** The primary person a co-worker answers to: the nearest human up its reports-to chain, else the owner. */
export async function accountableHumanFor(store: CoworkerStore, coworkerUserId: string): Promise<AccountableHuman> {
  return (await accountableHumansFor(store, coworkerUserId))[0]!
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
      const reportsToUserIds = positionManagers(position).filter((id) => chart.members.has(id))
      const accountableHumans = m.kind === 'coworker' ? accountableHumansIn(chart, m.id) : []
      return {
        id: m.id,
        name: m.name,
        image: memberImageOf(m),
        kind: m.kind,
        role: m.role,
        title: position?.title ?? null,
        accountabilities: position?.accountabilities ?? [],
        reportsToUserId: reportsToUserIds[0] ?? null,
        reportsToUserIds,
        accountableHuman: accountableHumans[0] ?? null,
        accountableHumans,
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

function normalizeManagerIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ids) {
    const id = raw.trim()
    if (!id) throw new CoworkerError('invalid_input', 'Manager user id cannot be empty.')
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function resolveManagersInput(input: { reportsToUserId?: string | null; reportsToUserIds?: string[] }): string[] | undefined {
  if (input.reportsToUserIds !== undefined) return normalizeManagerIds(input.reportsToUserIds)
  if (input.reportsToUserId !== undefined) {
    return input.reportsToUserId === null ? [] : normalizeManagerIds([input.reportsToUserId])
  }
  return undefined
}

async function resolveAvatar(
  input: { avatarPreset?: CoworkerAvatarPresetId | null; avatarSha256?: string | null },
  deps: CoworkerDeps,
): Promise<{ image: string | null; avatarSha256: string | null } | undefined> {
  const { avatarPreset, avatarSha256 } = input
  if (avatarPreset === undefined && avatarSha256 === undefined) return undefined
  if (avatarPreset != null && avatarSha256 != null) {
    throw new CoworkerError('invalid_input', 'Choose either an avatar preset or an uploaded avatar, not both.')
  }
  if (avatarPreset !== undefined && avatarPreset !== null) {
    if (!isCoworkerAvatarPresetId(avatarPreset)) {
      throw new CoworkerError('invalid_input', `Unknown co-worker avatar preset "${avatarPreset}".`)
    }
    return { image: coworkerAvatarPresetUrl(avatarPreset), avatarSha256: null }
  }
  if (avatarSha256 !== undefined && avatarSha256 !== null) {
    const sha = avatarSha256.trim().toLowerCase()
    if (!isAvatarSha(sha)) {
      throw new CoworkerError('invalid_input', 'The uploaded avatar id must be a 64-character SHA-256 hex digest.')
    }
    const exists = deps.avatarExists ? await deps.avatarExists(sha) : false
    if (!exists) {
      throw new CoworkerError('invalid_input', `Uploaded avatar ${sha} does not exist. Upload it first.`)
    }
    return { image: avatarUrl(sha), avatarSha256: sha }
  }
  return { image: null, avatarSha256: null }
}

/** Refuses self-reporting, unknown managers and any change that would close a reporting cycle. */
function assertManagers(chart: Chart, userId: string, managerIds: readonly string[]): void {
  for (const managerId of managerIds) {
    if (managerId === userId) throw new CoworkerError('org_cycle', 'Nobody can report to themselves.')
    if (!chart.members.has(managerId)) throw new CoworkerError('not_found', `No member ${managerId} to report to.`)
    if (ancestorsOf(chart, managerId).has(userId)) {
      throw new CoworkerError('org_cycle', `That would make a reporting cycle: ${managerId} already reports, through the chain, to ${userId}.`)
    }
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
  reportsToUserIds?: string[]
  dailyCapUsd?: number
  avatarPreset?: CoworkerAvatarPresetId | null
  avatarSha256?: string | null
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
  const avatar = (await resolveAvatar(input, deps)) ?? { image: null, avatarSha256: null }
  const reportsToUserIds = resolveManagersInput(input) ?? []
  const now = deps.now?.() ?? new Date()
  const id = deps.newId?.() ?? randomUUID().replaceAll('-', '')
  return deps.store.transaction(async (store) => {
    const chart = await loadChart(store)
    assertManagers(chart, id, reportsToUserIds)
    const slug = await freeSlug(store, name)
    await store.insertCoworker({
      user: { id, name, email: coworkerEmail(slug, id), image: avatar.image, avatarSha256: avatar.avatarSha256, createdAt: now },
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
      position: {
        userId: id,
        title,
        reportsToUserId: reportsToUserIds[0] ?? null,
        reportsToUserIds,
        accountabilities,
        updatedAt: now,
        updatedBy: actor.id,
      },
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
  reportsToUserIds?: string[]
  dailyCapUsd?: number
  avatarPreset?: CoworkerAvatarPresetId | null
  avatarSha256?: string | null
}

async function liveProfile(chart: Chart, userId: string): Promise<CoworkerProfileRow> {
  const profile = chart.profiles.get(userId)
  if (!profile) throw new CoworkerError('not_found', `No AI co-worker ${userId}.`)
  if (profile.removedAt) throw new CoworkerError('removed', `The AI co-worker ${userId} was removed; it can't be changed.`)
  return profile
}

/** Changes a co-worker's name, role card, model, cap, avatar or seat (only the fields given). */
export async function updateCoworker(actor: CoworkerActor, input: UpdateCoworkerInput, deps: CoworkerDeps): Promise<CoworkerView> {
  assertAdmin(actor)
  const avatar = await resolveAvatar(input, deps)
  const nextManagers = resolveManagersInput(input)
  const now = deps.now?.() ?? new Date()
  return deps.store.transaction(async (store) => {
    const chart = await loadChart(store)
    await liveProfile(chart, input.userId)
    const position = chart.positions.get(input.userId)
    const patch: CoworkerPatch = { profile: { updatedAt: now } }
    if (input.name !== undefined) patch.name = cleanText(input.name, 'The name', NAME_MAX)
    if (avatar !== undefined) patch.avatar = avatar
    if (input.lens !== undefined) patch.profile!.lens = cleanText(input.lens, 'The lens', LENS_MAX)
    if (input.modelId !== undefined) patch.profile!.modelId = chatModel(input.modelId)
    if (input.dailyCapUsd !== undefined) patch.profile!.dailyCapUsd = dailyCap(input.dailyCapUsd)
    if (input.title !== undefined || input.accountabilities !== undefined || nextManagers !== undefined) {
      if (nextManagers !== undefined) assertManagers(chart, input.userId, nextManagers)
      const reportsToUserIds = nextManagers ?? positionManagers(position)
      patch.position = {
        userId: input.userId,
        title: input.title === undefined ? (position?.title ?? null) : cleanText(input.title, 'The title', TITLE_MAX),
        accountabilities:
          input.accountabilities === undefined ? (position?.accountabilities ?? []) : cleanAccountabilities(input.accountabilities, 1),
        reportsToUserId: reportsToUserIds[0] ?? null,
        reportsToUserIds,
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
 * now reports to its manager(s).
 */
export async function removeCoworker(actor: CoworkerActor, input: { userId: string }, deps: CoworkerDeps): Promise<CoworkerView> {
  assertAdmin(actor)
  const now = deps.now?.() ?? new Date()
  return deps.store.transaction(async (store) => {
    const chart = await loadChart(store)
    await liveProfile(chart, input.userId)
    const reparentTo = positionManagers(chart.positions.get(input.userId))
    await store.markRemoved(input.userId, now, actor.id, reparentTo)
    return getCoworker(store, input.userId)
  })
}

export type SetOrgPositionInput = {
  userId: string
  title?: string | null
  accountabilities?: string[]
  /** Admins only. */
  reportsToUserId?: string | null
  /** Admins only. */
  reportsToUserIds?: string[]
}

/** Sets a seat in the org chart. An admin sets anyone's; a member only their own title and accountabilities. */
export async function setOrgPosition(actor: CoworkerActor, input: SetOrgPositionInput, deps: CoworkerDeps): Promise<OrgChartEntry> {
  if (actor.kind === 'coworker') {
    throw new CoworkerError('forbidden', 'A co-worker’s seat in the org chart is set by the owner or an admin.')
  }
  const admin = isAdminRole(actor.role)
  if (!admin) {
    if (input.userId !== actor.id) throw new CoworkerError('forbidden', 'You can only change your own title and accountabilities.')
    if (input.reportsToUserId !== undefined || input.reportsToUserIds !== undefined) {
      throw new CoworkerError('forbidden', 'Only the owner or an admin decides who reports to whom.')
    }
  }
  const nextManagers = resolveManagersInput(input)
  const now = deps.now?.() ?? new Date()
  return deps.store.transaction(async (store) => {
    const chart = await loadChart(store)
    if (!chart.members.has(input.userId)) throw new CoworkerError('not_found', `No member ${input.userId}.`)
    const current = chart.positions.get(input.userId)
    if (nextManagers !== undefined) assertManagers(chart, input.userId, nextManagers)
    const reportsToUserIds = nextManagers ?? positionManagers(current)
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
      reportsToUserId: reportsToUserIds[0] ?? null,
      reportsToUserIds,
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
