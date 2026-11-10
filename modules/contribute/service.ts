import type { ContributeStore, ContributionWithVotes, Directory } from './store'
import { randomUUID } from 'node:crypto'
import { ContributeError } from './errors'
import { judgeProposal, type JudgeChat } from './judge'
import {
  CONTRIBUTION_AREAS,
  CONTRIBUTION_KINDS,
  CONTRIBUTION_MAX_LENGTH,
  CONTRIBUTION_NOTE_MAX_LENGTH,
  CONTRIBUTION_STATUSES,
  OPEN_STATUSES,
  type ContributionArea,
  type ContributionCheck,
  type ContributionDto,
  type ContributionKind,
  type ContributionStatus,
  type MyVote,
} from './types'

/**
 * Contribute core (Eigen's Contribute board for the company): a person
 * proposes an improvement → the LLM judge reads kind and area and may name the
 * same request already open (the person then votes for it instead, or says
 * "mine's different") → the proposal lands as Requested with its author's +1.
 * Everyone votes; the makers (owner/admin) and the agent move proposals along
 * requested → in_progress → shipped, or decline them, with a note.
 */

/** How many open proposals the judge compares a draft against (newest first). */
export const JUDGE_CANDIDATES = 40

export type ContributeAudit = (event: { type: string; principalId: string; payload: Record<string, unknown> }) => Promise<void>

export type ContributeDeps = {
  store: ContributeStore
  directory: Directory
  chat: JudgeChat
  companyName: () => Promise<string | null>
  /** Kernel events for the activity feed; required (proposals are company activity). */
  audit: ContributeAudit
  now?: () => Date
  newId?: () => string
}

/** Who is acting: a person (with whether they may manage the board) or the agent. */
export type ContributeActor = { id: string; kind: 'human' | 'agent'; canManage: boolean }

const now = (d: ContributeDeps) => (d.now ? d.now() : new Date())
const newId = (d: ContributeDeps) => (d.newId ? d.newId() : randomUUID())

// ── boundary parsing (fail loud with the constraint) ──────────────────────────

export function parseTitle(value: unknown): string {
  if (typeof value !== 'string') throw new ContributeError('invalid', 'title must be a string')
  const title = value.trim()
  if (title.length === 0) throw new ContributeError('invalid', 'title must not be empty')
  if (title.length > CONTRIBUTION_MAX_LENGTH) {
    throw new ContributeError('invalid', `title must be at most ${CONTRIBUTION_MAX_LENGTH} characters`)
  }
  return title
}

function oneOf<T extends string>(list: readonly T[], field: string, value: unknown): T {
  if (typeof value === 'string' && (list as readonly string[]).includes(value)) return value as T
  throw new ContributeError('invalid', `${field} must be one of ${list.join(', ')}`)
}

export const parseKind = (v: unknown): ContributionKind => oneOf(CONTRIBUTION_KINDS, 'kind', v)
export const parseArea = (v: unknown): ContributionArea => oneOf(CONTRIBUTION_AREAS, 'area', v)
export const parseStatus = (v: unknown): ContributionStatus => oneOf(CONTRIBUTION_STATUSES, 'status', v)

/** A note: a non-empty string up to the limit, or null to clear it. */
export function parseNote(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new ContributeError('invalid', 'note must be a string, or null to clear it')
  const note = value.trim()
  if (note.length === 0) throw new ContributeError('invalid', 'note must not be empty (send null to clear it)')
  if (note.length > CONTRIBUTION_NOTE_MAX_LENGTH) {
    throw new ContributeError('invalid', `note must be at most ${CONTRIBUTION_NOTE_MAX_LENGTH} characters`)
  }
  return note
}

export function parseDirection(value: unknown): MyVote {
  if (value === -1 || value === 0 || value === 1) return value
  throw new ContributeError('invalid', `direction must be -1, 0 or 1 (got ${JSON.stringify(value ?? null)})`)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value.trim())) {
    throw new ContributeError('invalid', `id must be a proposal id (UUID), got ${JSON.stringify(value ?? null)}`)
  }
  return value.trim().toLowerCase()
}

// ── views ─────────────────────────────────────────────────────────────────────

function toDto(row: ContributionWithVotes, names: Map<string, string>, viewerId: string | null): ContributionDto {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    area: row.area,
    status: row.status,
    score: row.score,
    myVote: viewerId ? (row.votes.get(viewerId) ?? 0) : 0,
    own: viewerId !== null && row.authorId === viewerId,
    authorId: row.authorId,
    authorName: names.get(row.authorId) ?? 'Former member',
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    shippedAt: row.shippedAt ? row.shippedAt.toISOString() : null,
  }
}

/** Board order: most wanted first (net score), newest breaking ties; shipped by ship date. */
function boardOrder(a: ContributionWithVotes, b: ContributionWithVotes): number {
  if (a.status === 'shipped' && b.status === 'shipped') {
    return (b.shippedAt?.getTime() ?? 0) - (a.shippedAt?.getTime() ?? 0)
  }
  return b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime()
}

async function view(d: ContributeDeps, id: string, viewerId: string | null): Promise<ContributionDto> {
  const row = await d.store.get(id)
  if (!row) throw new ContributeError('not_found', 'proposal not found')
  return toDto(row, await d.directory.names(), viewerId)
}

/** Proposals in the given statuses (default: everything on the board), board order. */
export async function listProposals(
  d: ContributeDeps,
  viewerId: string | null,
  statuses: readonly ContributionStatus[] = ['requested', 'in_progress', 'shipped'],
): Promise<ContributionDto[]> {
  const [rows, names] = await Promise.all([d.store.list(statuses), d.directory.names()])
  return rows.sort(boardOrder).map((r) => toDto(r, names, viewerId))
}

export async function getProposal(d: ContributeDeps, viewerId: string | null, id: string): Promise<ContributionDto> {
  return view(d, parseId(id), viewerId)
}

// ── propose ───────────────────────────────────────────────────────────────────

/** The judge's reading of a draft. Nothing is created here. */
export async function checkProposal(d: ContributeDeps, userId: string, rawTitle: unknown): Promise<ContributionCheck> {
  const title = parseTitle(rawTitle)
  const open = (await d.store.list(OPEN_STATUSES)).slice(0, JUDGE_CANDIDATES)
  const decision = await judgeProposal(d.chat, {
    userId,
    companyName: await d.companyName(),
    title,
    candidates: open.map((c) => ({ id: c.id, title: c.title, kind: c.kind, area: c.area, status: c.status })),
  })
  const duplicateOf = decision.duplicateOfId ? await view(d, decision.duplicateOfId, userId) : null
  return { kind: decision.kind, area: decision.area, duplicateOf }
}

/** Create the proposal (Requested, with its author's +1) with the judge's kind and area. */
export async function shareProposal(
  d: ContributeDeps,
  userId: string,
  input: { title: unknown; kind: unknown; area: unknown },
): Promise<ContributionDto> {
  const title = parseTitle(input.title)
  const kind = parseKind(input.kind)
  const area = parseArea(input.area)
  const at = now(d)
  const id = newId(d)
  await d.store.insert({ id, title, kind, area, status: 'requested', authorId: userId, note: null, createdAt: at, updatedAt: at, shippedAt: null })
  await d.audit({ type: 'contribute.proposed', principalId: userId, payload: { id, title, kind, area } })
  return view(d, id, userId)
}

// ── vote ──────────────────────────────────────────────────────────────────────

/** +1, -1 or 0 (take the vote back). Shipped and declined proposals are closed. */
export async function voteProposal(d: ContributeDeps, userId: string, rawId: unknown, rawDirection: unknown): Promise<ContributionDto> {
  const id = parseId(rawId)
  const direction = parseDirection(rawDirection)
  const row = await d.store.get(id)
  if (!row || row.status === 'declined') throw new ContributeError('not_found', 'proposal not found')
  if (row.status === 'shipped') throw new ContributeError('conflict', 'this proposal has shipped — voting is closed')
  await d.store.setVote(id, userId, direction)
  return view(d, id, userId)
}

// ── manage (makers + agent) ───────────────────────────────────────────────────

/**
 * Move a proposal along (status) and/or set the note people read on it.
 * Shipping stamps shipped_at; moving away clears it. Only the owner/admins
 * and the agent manage the board.
 */
export async function updateProposal(
  d: ContributeDeps,
  actor: ContributeActor,
  rawId: unknown,
  patch: { status?: unknown; note?: unknown },
): Promise<ContributionDto> {
  if (!actor.canManage) throw new ContributeError('forbidden', 'only the owner and admins manage the board')
  const id = parseId(rawId)
  const hasStatus = patch.status !== undefined
  const hasNote = patch.note !== undefined
  if (!hasStatus && !hasNote) throw new ContributeError('invalid', 'nothing to change: send status and/or note')
  const status = hasStatus ? parseStatus(patch.status) : undefined
  const note = hasNote ? parseNote(patch.note) : undefined
  const row = await d.store.get(id)
  if (!row) throw new ContributeError('not_found', 'proposal not found')
  const at = now(d)
  const shippedAt =
    status === undefined ? undefined : status === 'shipped' ? (row.status === 'shipped' ? row.shippedAt : at) : null
  await d.store.update(id, {
    ...(status !== undefined ? { status } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(shippedAt !== undefined ? { shippedAt } : {}),
    updatedAt: at,
  })
  if (status !== undefined && status !== row.status) {
    await d.audit({ type: 'contribute.status_changed', principalId: actor.id, payload: { id, title: row.title, from: row.status, to: status } })
  }
  return view(d, id, actor.kind === 'human' ? actor.id : null)
}
