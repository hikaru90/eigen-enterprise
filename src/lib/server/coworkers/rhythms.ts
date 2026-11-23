import type { CoworkerRunRow, CoworkerRunStore, NewCoworkerRun } from './run-store'
import type { CoworkerActor, CoworkerView } from './service'
import { randomUUID } from 'node:crypto'
import { isAdminRole } from '$lib/server/auth/roles'
import { dueOccurrences, nextOccurrence, ReminderScheduleError, validateSchedule, type Weekday, type WeeklySchedule } from '$lib/server/memory/reminders/schedule'
import { CoworkerError } from './service'

/**
 * A co-worker's rhythms (plan/phase-ai-coworkers.md §2 "proactive too", C6):
 * scheduled check-ins — "weekdays 9:00 Europe/Berlin, post the marketing
 * standup in #marketing". The schedule is the reminders' weekly rhythm
 * (weekdays + wall time + time zone, DST-safe: memory/reminders/schedule.ts).
 *
 * At each due slot the co-worker takes a turn in the target conversation and
 * posts a new top-level message (turns.ts, work runs). No model decides
 * whether to post: a rhythm always produces its post. Missed slots (the
 * server was down) are not replayed: a tick takes only the latest due slot.
 *
 * Exactly one run per slot across app processes: the tick moves the rhythm's
 * last_slot_at forward with a compare-and-set and queues the slot's run in the
 * same transaction (trigger_key rhythm:<id>:<slot> is unique besides).
 *
 * Who may: every member reads a co-worker's rhythms (where a rhythm posts is
 * hidden when the reader may not see that conversation); the owner and admins
 * create, change, delete and run them now. The target must be a conversation
 * the co-worker is a member of — refused at create, and a run at slot time
 * stops with a visible reason (not_member) when it left since.
 */

export const INSTRUCTION_MAX = 2000

export type RhythmRow = {
  id: string
  coworkerUserId: string
  weekdays: Weekday[]
  /** HH:MM. */
  time: string
  timeZone: string
  instruction: string
  targetConversationId: string
  enabled: boolean
  /** The slot it handled last (creation or the last schedule change counts as handled). */
  lastSlotAt: Date
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export type RhythmPatch = Partial<Pick<RhythmRow, 'weekdays' | 'time' | 'timeZone' | 'instruction' | 'targetConversationId' | 'enabled' | 'lastSlotAt'>> & {
  updatedAt: Date
}

export type RhythmStore = {
  /** Every rhythm (one co-worker's when given), oldest first. */
  list(coworkerUserId?: string): Promise<RhythmRow[]>
  get(id: string): Promise<RhythmRow | null>
  insert(row: RhythmRow): Promise<void>
  update(id: string, patch: RhythmPatch): Promise<RhythmRow>
  delete(id: string): Promise<boolean>
  /**
   * Takes a slot: moves last_slot_at from `from` to `to` only if it still is
   * `from` (another process may have taken it), and queues `run` with it in
   * one transaction (null = advance without a run: the co-worker is off).
   */
  takeSlot(id: string, from: Date, to: Date, run: NewCoworkerRun | null): Promise<{ won: boolean; run: CoworkerRunRow | null }>
}

/** Whether a co-worker may post in a conversation, and whether the reader may see it (null = no reader check). */
export type TargetAccess = {
  coworkerMayPost(coworkerUserId: string, conversationId: string): Promise<boolean>
  /** The conversation's title as the reader may see it; null when it does not exist or the reader may not see it. */
  titleFor(readerId: string, conversationId: string, coworkerUserId: string): Promise<string | null>
  /** Where a rhythm of the co-worker may post that the reader may see: its conversations (channels as #name, DMs by who is in them). */
  listFor(coworkerUserId: string, readerId: string): Promise<RhythmTarget[]>
}

export type RhythmTarget = { id: string; title: string; kind: 'channel' | 'dm' }

export type RhythmDeps = {
  store: RhythmStore
  runs: CoworkerRunStore
  coworkers: { get(userId: string): Promise<CoworkerView> }
  targets: TargetAccess
  /** Starts a queued run in this process (the co-worker turns). */
  start(runId: string): void
  /** Throws when this process cannot run co-worker turns: checked before a run is queued (it would wait for another process's sweep). */
  ready(): void
  now?: () => Date
  newId?: () => string
}

export type RhythmView = {
  id: string
  coworkerUserId: string
  weekdays: Weekday[]
  time: string
  timeZone: string
  instruction: string
  /** Null when the reader may not see the conversation (`hidden`). */
  targetConversationId: string | null
  targetTitle: string | null
  hidden: boolean
  enabled: boolean
  /** The next slot (ISO), null while it is switched off. */
  nextAt: string | null
  lastSlotAt: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

const nowOf = (d: RhythmDeps) => (d.now ? d.now() : new Date())
const scheduleOf = (r: Pick<RhythmRow, 'weekdays' | 'time' | 'timeZone'>): WeeklySchedule => ({ weekdays: r.weekdays, time: r.time, timeZone: r.timeZone })

function assertAdmin(actor: CoworkerActor): void {
  if (actor.kind === 'coworker' || !isAdminRole(actor.role)) {
    throw new CoworkerError('forbidden', 'Only the owner or an admin manages an AI co-worker’s rhythms.')
  }
}

function schedule(s: { weekdays: readonly string[]; time: string; timeZone: string }): WeeklySchedule {
  try {
    return validateSchedule(s)
  } catch (err) {
    if (err instanceof ReminderScheduleError) throw new CoworkerError('invalid_input', err.message.replace('A reminder', 'A rhythm'))
    throw err
  }
}

function instructionOf(text: string): string {
  const v = text.trim()
  if (!v || v.length > INSTRUCTION_MAX) throw new CoworkerError('invalid_input', `The instruction must be 1 to ${INSTRUCTION_MAX} characters.`)
  return v
}

async function workingCoworker(d: RhythmDeps, userId: string): Promise<CoworkerView> {
  const view = await d.coworkers.get(userId)
  if (view.removedAt) throw new CoworkerError('removed', `The AI co-worker ${view.name} was removed; it has no rhythms any more.`)
  return view
}

async function assertMayPost(d: RhythmDeps, view: CoworkerView, conversationId: string, actorId: string): Promise<void> {
  // The person setting it up must see where it posts: no posting into a conversation they cannot read.
  if ((await d.targets.titleFor(actorId, conversationId, view.id)) === null) {
    throw new CoworkerError('not_found', 'No conversation with that id that you can see.')
  }
  if (!(await d.targets.coworkerMayPost(view.id, conversationId))) {
    throw new CoworkerError('not_member', `${view.name} is not a member of that conversation. Add it to the channel first, then set up the rhythm.`)
  }
}

async function requireRhythm(d: RhythmDeps, id: string): Promise<RhythmRow> {
  const r = await d.store.get(id)
  if (!r) throw new CoworkerError('not_found', `No rhythm ${id}.`)
  return r
}

async function viewOf(d: RhythmDeps, readerId: string, r: RhythmRow): Promise<RhythmView> {
  const title = await d.targets.titleFor(readerId, r.targetConversationId, r.coworkerUserId)
  const now = nowOf(d)
  const after = r.lastSlotAt > now ? r.lastSlotAt : now
  return {
    id: r.id,
    coworkerUserId: r.coworkerUserId,
    weekdays: [...r.weekdays],
    time: r.time,
    timeZone: r.timeZone,
    instruction: r.instruction,
    targetConversationId: title === null ? null : r.targetConversationId,
    targetTitle: title,
    hidden: title === null,
    enabled: r.enabled,
    nextAt: r.enabled ? nextOccurrence(scheduleOf(r), after).toISOString() : null,
    lastSlotAt: r.lastSlotAt.toISOString(),
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function listRhythms(d: RhythmDeps, readerId: string, coworkerUserId: string): Promise<RhythmView[]> {
  await d.coworkers.get(coworkerUserId)
  const out: RhythmView[] = []
  for (const r of await d.store.list(coworkerUserId)) out.push(await viewOf(d, readerId, r))
  return out
}

/** The conversations a new rhythm of the co-worker can post in, as the reader may see them. */
export async function rhythmTargets(d: RhythmDeps, readerId: string, coworkerUserId: string): Promise<RhythmTarget[]> {
  await d.coworkers.get(coworkerUserId)
  return d.targets.listFor(coworkerUserId, readerId)
}

export type CreateRhythmInput = {
  coworkerUserId: string
  weekdays: readonly string[]
  time: string
  timeZone: string
  instruction: string
  targetConversationId: string
  enabled?: boolean
}

export async function createRhythm(d: RhythmDeps, actor: CoworkerActor, input: CreateRhythmInput): Promise<RhythmView> {
  assertAdmin(actor)
  const s = schedule(input)
  const instruction = instructionOf(input.instruction)
  const view = await workingCoworker(d, input.coworkerUserId)
  await assertMayPost(d, view, input.targetConversationId, actor.id)
  const at = nowOf(d)
  const row: RhythmRow = {
    id: d.newId ? d.newId() : randomUUID(),
    coworkerUserId: view.id,
    weekdays: s.weekdays,
    time: s.time,
    timeZone: s.timeZone,
    instruction,
    targetConversationId: input.targetConversationId,
    enabled: input.enabled ?? true,
    // Slots before it existed are not its to post.
    lastSlotAt: at,
    createdBy: actor.id,
    createdAt: at,
    updatedAt: at,
  }
  await d.store.insert(row)
  return viewOf(d, actor.id, row)
}

export type UpdateRhythmInput = {
  id: string
  weekdays?: readonly string[]
  time?: string
  timeZone?: string
  instruction?: string
  targetConversationId?: string
  enabled?: boolean
}

export async function updateRhythm(d: RhythmDeps, actor: CoworkerActor, input: UpdateRhythmInput): Promise<RhythmView> {
  assertAdmin(actor)
  const r = await requireRhythm(d, input.id)
  const { id: _id, ...given } = input
  if (Object.values(given).every((v) => v === undefined)) {
    throw new CoworkerError('invalid_input', 'Give at least one of weekdays, time, time zone, instruction, conversation or enabled to change.')
  }
  const at = nowOf(d)
  const patch: RhythmPatch = { updatedAt: at }
  if (input.weekdays !== undefined || input.time !== undefined || input.timeZone !== undefined) {
    const s = schedule({ weekdays: input.weekdays ?? r.weekdays, time: input.time ?? r.time, timeZone: input.timeZone ?? r.timeZone })
    Object.assign(patch, { weekdays: s.weekdays, time: s.time, timeZone: s.timeZone })
    // A new schedule starts from now: no slot of the old one is posted late.
    patch.lastSlotAt = at
  }
  if (input.instruction !== undefined) patch.instruction = instructionOf(input.instruction)
  if (input.targetConversationId !== undefined && input.targetConversationId !== r.targetConversationId) {
    await assertMayPost(d, await workingCoworker(d, r.coworkerUserId), input.targetConversationId, actor.id)
    patch.targetConversationId = input.targetConversationId
  }
  if (input.enabled !== undefined && input.enabled !== r.enabled) {
    patch.enabled = input.enabled
    // Switched back on: the slots it was off for are not posted late.
    if (input.enabled) patch.lastSlotAt = at
  }
  return viewOf(d, actor.id, await d.store.update(r.id, patch))
}

export async function deleteRhythm(d: RhythmDeps, actor: CoworkerActor, id: string): Promise<{ id: string; deleted: true }> {
  assertAdmin(actor)
  await requireRhythm(d, id)
  if (!(await d.store.delete(id))) throw new CoworkerError('not_found', `No rhythm ${id}.`)
  return { id, deleted: true }
}

const slotRun = (r: RhythmRow, at: Date, key: string, requestedBy: string): NewCoworkerRun => ({
  coworkerUserId: r.coworkerUserId,
  triggerKind: 'rhythm',
  conversationId: r.targetConversationId,
  threadRootId: null,
  triggerMessageId: null,
  requestedByUserId: requestedBy,
  triggeredAt: at,
  rhythmId: r.id,
  taskId: null,
  triggerKey: key,
})

/** "Run now" (admins): queues one rhythm run outside the schedule and starts it; the schedule is untouched. */
export async function runRhythmNow(d: RhythmDeps, actor: CoworkerActor, id: string): Promise<CoworkerRunRow> {
  assertAdmin(actor)
  const r = await requireRhythm(d, id)
  const view = await workingCoworker(d, r.coworkerUserId)
  if (!view.enabled) throw new CoworkerError('invalid_input', `${view.name} is switched off; switch it on to run its rhythm.`)
  d.ready()
  const at = nowOf(d)
  const run = await d.runs.enqueue(slotRun(r, at, `rhythm:${r.id}:now:${d.newId ? d.newId() : randomUUID()}`, actor.id))
  if (!run) throw new Error(`queuing a run of rhythm ${r.id} was a no-op: its trigger key already exists`)
  d.start(run.id)
  return run
}

/**
 * One tick (the global job-queue tick, every minute): for every switched-on
 * rhythm with a due slot, takes the latest slot and queues its run, then
 * starts it. A co-worker that is off or removed takes the slot without a run.
 * The rhythm's conversation is checked when the run starts (turns.ts): a
 * co-worker no longer in it stops with not_member, visibly.
 */
export async function tickRhythms(d: RhythmDeps): Promise<CoworkerRunRow[]> {
  d.ready()
  const now = nowOf(d)
  const queued: CoworkerRunRow[] = []
  for (const r of await d.store.list()) {
    if (!r.enabled) continue
    const due = dueOccurrences(scheduleOf(r), r.lastSlotAt, now)
    if (!due) continue
    const view = await d.coworkers.get(r.coworkerUserId)
    const working = view.enabled && view.removedAt === null
    const slot = due.latest
    const taken = await d.store.takeSlot(r.id, r.lastSlotAt, slot, working ? slotRun(r, slot, `rhythm:${r.id}:${slot.toISOString()}`, r.createdBy) : null)
    if (!taken.run) continue
    queued.push(taken.run)
    d.start(taken.run.id)
  }
  return queued
}

/** In-memory store for specs: the same contract over a memory run store. */
export class MemoryRhythmStore implements RhythmStore {
  readonly rows: RhythmRow[] = []

  constructor(private readonly runs: CoworkerRunStore) {}

  async list(coworkerUserId?: string): Promise<RhythmRow[]> {
    return this.rows
      .filter((r) => coworkerUserId === undefined || r.coworkerUserId === coworkerUserId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => ({ ...r, weekdays: [...r.weekdays] }))
  }

  async get(id: string): Promise<RhythmRow | null> {
    const r = this.rows.find((x) => x.id === id)
    return r ? { ...r, weekdays: [...r.weekdays] } : null
  }

  async insert(row: RhythmRow): Promise<void> {
    this.rows.push({ ...row })
  }

  async update(id: string, patch: RhythmPatch): Promise<RhythmRow> {
    const r = this.rows.find((x) => x.id === id)
    if (!r) throw new Error(`no rhythm ${id}`)
    Object.assign(r, patch)
    return { ...r }
  }

  async delete(id: string): Promise<boolean> {
    const i = this.rows.findIndex((x) => x.id === id)
    if (i < 0) return false
    this.rows.splice(i, 1)
    return true
  }

  async takeSlot(id: string, from: Date, to: Date, run: NewCoworkerRun | null): Promise<{ won: boolean; run: CoworkerRunRow | null }> {
    const r = this.rows.find((x) => x.id === id)
    if (!r || r.lastSlotAt.getTime() !== from.getTime()) return { won: false, run: null }
    r.lastSlotAt = to
    return { won: true, run: run ? await this.runs.enqueue(run) : null }
  }
}
