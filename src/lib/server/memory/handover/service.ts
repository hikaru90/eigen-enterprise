import type { TaskDirectory } from '$lib/server/memory/assigned-tasks/service'
import {
  HANDOVER_STATUSES,
  HandoverTopicTakenError,
  type Handover,
  type HandoverEntry,
  type HandoverEntryPatch,
  type HandoverEntryVia,
  type HandoverStatus,
  type HandoverStore,
} from './store'

/**
 * Handover (plan/handover.md, Contribute b92e6ba5): a page per person or per
 * topic where the company brain and its owner keep the current state — one
 * entry per topic: the day, the topic, one sentence, a status (decision
 * needed / in progress / for info) and a link to the detail document or item.
 *
 * Every member of the company reads every handover (no per-item sharing:
 * that is the point of the page); only its owner — themself, their assistant
 * on their word, or the brain's upkeep acting for them — writes it. Assigning
 * an entry to a member gives them an assigned task from the owner (the
 * existing mechanism, assigned-tasks/service.ts), so it lands in their Needs
 * you with push and email; an entry nobody is assigned stays information.
 */

export type HandoverActor = { userId: string; via: HandoverEntryVia }

/** The assigned-task port: give the entry to a member, and read whether that task is still open. */
export type HandoverTasks = {
  assign(actor: { userId: string; via: 'person' | 'assistant' }, input: { assigneeId: string; title: string; context: string }): Promise<{ id: string }>
  status(taskId: string): Promise<'open' | 'done' | null>
}

export type HandoverDeps = {
  store: HandoverStore
  /** The company's members (people and AI co-workers), never contacts. */
  directory: TaskDirectory
  tasks: HandoverTasks
  now?: () => Date
  newId?: () => string
}

export type HandoverPerson = { id: string; name: string }

export type HandoverEntryView = {
  id: string
  handoverId: string
  date: string
  topic: string
  sentence: string
  status: HandoverStatus
  link: string | null
  assignee: HandoverPerson | null
  assignedTask: { id: string; status: 'open' | 'done' } | null
  writtenVia: HandoverEntryVia
  updatedAt: string
}

export type HandoverSummary = {
  id: string
  title: string
  owner: HandoverPerson
  subject: HandoverPerson | null
  /** The viewer owns it (only the owner writes). */
  canEdit: boolean
  updatedAt: string
  entryCount: number
  /** How many entries wait for a decision. */
  decisionsNeeded: number
}

export type HandoverView = Omit<HandoverSummary, 'entryCount' | 'decisionsNeeded'> & { entries: HandoverEntryView[] }

export class HandoverError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'forbidden' | 'conflict',
    message: string,
  ) {
    super(message)
    this.name = 'HandoverError'
  }
}

export const HANDOVER_URL = '/m/memory/handover'
export const FORMER_MEMBER = 'A former member'
export const TITLE_MAX = 200
export const TOPIC_MAX = 120
export const SENTENCE_MAX = 400
export const LINK_MAX = 2000

const nowOf = (d: HandoverDeps) => (d.now ? d.now() : new Date())
const newIdOf = (d: HandoverDeps) => (d.newId ? d.newId() : crypto.randomUUID())
const today = (d: HandoverDeps) => nowOf(d).toISOString().slice(0, 10)

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

function text(value: string, max: number, what: string): string {
  const v = value.trim()
  if (!v || v.length > max) throw new HandoverError('invalid', `${what} needs 1 to ${max} characters.`)
  return v
}

function status(value: string): HandoverStatus {
  if (!(HANDOVER_STATUSES as readonly string[]).includes(value)) {
    throw new HandoverError('invalid', `The status is one of ${HANDOVER_STATUSES.join(', ')} (got "${value}").`)
  }
  return value as HandoverStatus
}

/** A link is an app path (/m/…) or an http(s) URL; anything else (javascript:, //host) is refused. */
function link(value: string | null | undefined): string | null {
  const v = value?.trim() ?? ''
  if (!v) return null
  if (v.length > LINK_MAX) throw new HandoverError('invalid', `The link is longer than ${LINK_MAX} characters.`)
  if (v.startsWith('/') && !v.startsWith('//')) return v
  try {
    const url = new URL(v)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString()
  } catch {
    // not a URL: refused below
  }
  throw new HandoverError('invalid', `The link must be an app path like /m/memory/notes/… or an http(s) address (got "${v}").`)
}

function day(value: string | undefined, d: HandoverDeps): string {
  const v = value?.trim()
  if (!v) return today(d)
  if (!validDay(v)) throw new HandoverError('invalid', `The day must be a calendar day as YYYY-MM-DD (got "${v}").`)
  return v
}

async function requireMember(d: HandoverDeps, id: string, message: string) {
  const person = await d.directory.get(id)
  if (!person) throw new HandoverError('forbidden', message)
  return person
}

const NOT_A_MEMBER = 'Handovers are for the members of this company.'

async function requireHandover(d: HandoverDeps, id: string): Promise<Handover> {
  const h = await d.store.getHandover(id)
  if (!h) throw new HandoverError('not_found', 'Handover not found.')
  return h
}

async function ownedHandover(d: HandoverDeps, actor: HandoverActor, id: string): Promise<Handover> {
  await requireMember(d, actor.userId, NOT_A_MEMBER)
  const h = await requireHandover(d, id)
  if (h.ownerId !== actor.userId) {
    const owner = (await d.directory.get(h.ownerId))?.name ?? FORMER_MEMBER
    throw new HandoverError('forbidden', `Only ${owner} changes "${h.title}": it is their handover. Everyone in the company reads it.`)
  }
  return h
}

async function ownedEntry(d: HandoverDeps, actor: HandoverActor, entryId: string): Promise<{ handover: Handover; entry: HandoverEntry }> {
  await requireMember(d, actor.userId, NOT_A_MEMBER)
  const entry = await d.store.getEntry(entryId)
  if (!entry) throw new HandoverError('not_found', 'Handover entry not found.')
  return { handover: await ownedHandover(d, actor, entry.handoverId), entry }
}

type Names = (id: string) => Promise<HandoverPerson>

function namesOf(d: HandoverDeps): Names {
  const cache = new Map<string, Promise<HandoverPerson>>()
  return (id) => {
    let p = cache.get(id)
    if (!p) {
      p = d.directory.get(id).then((m) => ({ id, name: m?.name ?? FORMER_MEMBER }))
      cache.set(id, p)
    }
    return p
  }
}

async function entryView(d: HandoverDeps, names: Names, e: HandoverEntry): Promise<HandoverEntryView> {
  const taskStatus = e.assignedTaskId ? await d.tasks.status(e.assignedTaskId) : null
  return {
    id: e.id,
    handoverId: e.handoverId,
    date: e.entryOn,
    topic: e.topic,
    sentence: e.sentence,
    status: e.status,
    link: e.link,
    assignee: e.assigneeId ? await names(e.assigneeId) : null,
    assignedTask: e.assignedTaskId && taskStatus ? { id: e.assignedTaskId, status: taskStatus } : null,
    writtenVia: e.writtenVia,
    updatedAt: e.updatedAt.toISOString(),
  }
}

async function head(names: Names, viewerId: string, h: Handover) {
  return {
    id: h.id,
    title: h.title,
    owner: await names(h.ownerId),
    subject: h.subjectId ? await names(h.subjectId) : null,
    canEdit: h.ownerId === viewerId,
    updatedAt: h.updatedAt.toISOString(),
  }
}

async function views(d: HandoverDeps, viewerId: string, handovers: Handover[]): Promise<HandoverView[]> {
  const names = namesOf(d)
  const entries = await d.store.listEntries(handovers.map((h) => h.id))
  const out: HandoverView[] = []
  for (const h of handovers) {
    const mine = entries.filter((e) => e.handoverId === h.id)
    out.push({ ...(await head(names, viewerId, h)), entries: await Promise.all(mine.map((e) => entryView(d, names, e))) })
  }
  return out
}

async function viewOf(d: HandoverDeps, viewerId: string, id: string): Promise<HandoverView> {
  return (await views(d, viewerId, [await requireHandover(d, id)]))[0]!
}

async function entryOut(d: HandoverDeps, e: HandoverEntry): Promise<HandoverEntryView> {
  return entryView(d, namesOf(d), e)
}

export async function createHandover(d: HandoverDeps, actor: HandoverActor, input: { title: string; subjectId?: string | null }): Promise<HandoverView> {
  await requireMember(d, actor.userId, NOT_A_MEMBER)
  const title = text(input.title, TITLE_MAX, 'A handover title')
  const subjectId = input.subjectId?.trim() || null
  if (subjectId && !(await d.directory.get(subjectId))) {
    throw new HandoverError('invalid', `"${subjectId}" is not a member of this company. A handover is for a member (members.list) or a topic (no subject).`)
  }
  const at = nowOf(d)
  const h: Handover = { id: newIdOf(d), ownerId: actor.userId, title, subjectId, createdAt: at, updatedAt: at }
  await d.store.insertHandover(h)
  return viewOf(d, actor.userId, h.id)
}

export async function listHandovers(d: HandoverDeps, viewerId: string): Promise<HandoverSummary[]> {
  await requireMember(d, viewerId, NOT_A_MEMBER)
  return (await views(d, viewerId, await d.store.listHandovers())).map(({ entries, ...h }) => ({
    ...h,
    entryCount: entries.length,
    decisionsNeeded: entries.filter((e) => e.status === 'decision_needed').length,
  }))
}

/** Every handover with its entries (the Handover page). */
export async function handoverBoard(d: HandoverDeps, viewerId: string): Promise<HandoverView[]> {
  await requireMember(d, viewerId, NOT_A_MEMBER)
  return views(d, viewerId, await d.store.listHandovers())
}

export async function getHandover(d: HandoverDeps, viewerId: string, id: string): Promise<HandoverView> {
  await requireMember(d, viewerId, NOT_A_MEMBER)
  return viewOf(d, viewerId, id)
}

const takenMessage = (topic: string) =>
  `This handover already has an entry on "${topic}": one entry per topic. Change that entry instead (handover.update_entry).`

export type NewEntry = {
  handoverId: string
  topic: string
  sentence: string
  status: HandoverStatus
  link?: string | null
  entryOn?: string
}

export async function addEntry(d: HandoverDeps, actor: HandoverActor, input: NewEntry): Promise<HandoverEntryView> {
  const h = await ownedHandover(d, actor, input.handoverId)
  const at = nowOf(d)
  const entry: HandoverEntry = {
    id: newIdOf(d),
    handoverId: h.id,
    entryOn: day(input.entryOn, d),
    topic: text(input.topic, TOPIC_MAX, 'A topic'),
    sentence: text(input.sentence, SENTENCE_MAX, 'The sentence'),
    status: status(input.status),
    link: link(input.link),
    assigneeId: null,
    assignedTaskId: null,
    writtenVia: actor.via,
    createdAt: at,
    updatedAt: at,
  }
  if (await d.store.entryByTopic(h.id, entry.topic)) throw new HandoverError('conflict', takenMessage(entry.topic))
  try {
    await d.store.insertEntry(entry)
  } catch (err) {
    if (err instanceof HandoverTopicTakenError) throw new HandoverError('conflict', takenMessage(entry.topic))
    throw err
  }
  await d.store.touchHandover(h.id, at)
  return entryOut(d, entry)
}

export type EntryChange = {
  entryId: string
  topic?: string
  sentence?: string
  status?: HandoverStatus
  /** null clears the link. */
  link?: string | null
  entryOn?: string
}

export async function updateEntry(d: HandoverDeps, actor: HandoverActor, input: EntryChange): Promise<HandoverEntryView> {
  const { handover, entry } = await ownedEntry(d, actor, input.entryId)
  const at = nowOf(d)
  const patch: HandoverEntryPatch = { updatedAt: at, writtenVia: actor.via }
  if (input.topic !== undefined) patch.topic = text(input.topic, TOPIC_MAX, 'A topic')
  if (input.sentence !== undefined) patch.sentence = text(input.sentence, SENTENCE_MAX, 'The sentence')
  if (input.status !== undefined) patch.status = status(input.status)
  if (input.link !== undefined) patch.link = link(input.link)
  // A changed entry speaks for the day it changed, unless a day is given.
  patch.entryOn = day(input.entryOn, d)
  let updated: HandoverEntry | null
  try {
    updated = await d.store.updateEntry(entry.id, patch)
  } catch (err) {
    if (err instanceof HandoverTopicTakenError) throw new HandoverError('conflict', takenMessage(err.topic))
    throw err
  }
  if (!updated) throw new HandoverError('not_found', 'Handover entry not found.')
  await d.store.touchHandover(handover.id, at)
  return entryOut(d, updated)
}

/**
 * Removes an entry. An assigned task it gave out stays with its assignee (it is
 * their task now; they complete it in Memory › Tasks).
 */
export async function removeEntry(d: HandoverDeps, actor: HandoverActor, entryId: string): Promise<{ id: string; removed: true }> {
  const { handover, entry } = await ownedEntry(d, actor, entryId)
  if (!(await d.store.deleteEntry(entry.id))) throw new HandoverError('not_found', 'Handover entry not found.')
  await d.store.touchHandover(handover.id, nowOf(d))
  return { id: entry.id, removed: true }
}

/**
 * Removes a whole handover with its entries (Contribute 8587d182: a mistakenly
 * created handover must not stay forever). Owner-only, like every write. An
 * assigned task an entry gave out stays with its assignee (it is their task).
 */
export async function removeHandover(d: HandoverDeps, actor: HandoverActor, id: string): Promise<{ id: string; removed: true }> {
  const handover = await ownedHandover(d, actor, id)
  if (!(await d.store.deleteHandover(handover.id))) throw new HandoverError('not_found', 'Handover not found.')
  return { id: handover.id, removed: true }
}

const STATUS_WORDS: Record<HandoverStatus, string> = {
  decision_needed: 'Decision needed',
  in_progress: 'In progress',
  for_info: 'For information',
}

/**
 * Assigns an entry to a member: they get an assigned task from the owner (Needs
 * you, Memory › Tasks, push and email), its context the sentence, the status,
 * the detail link and the way back to the entry. One open assignment per entry:
 * a new one waits until the assignee completed the earlier task.
 */
export async function assignEntry(d: HandoverDeps, actor: HandoverActor, input: { entryId: string; assigneeId: string }): Promise<HandoverEntryView> {
  const { handover, entry } = await ownedEntry(d, actor, input.entryId)
  const assigneeId = input.assigneeId.trim()
  if (assigneeId === actor.userId) {
    throw new HandoverError('invalid', 'This is your own handover: an entry is assigned to another member. Unassigned entries stay information.')
  }
  const assignee = await d.directory.get(assigneeId)
  if (!assignee) throw new HandoverError('invalid', `"${assigneeId}" is not a member of this company. Pick a member (tasks.assignees), not a contact.`)
  if (entry.assignedTaskId && (await d.tasks.status(entry.assignedTaskId)) === 'open') {
    const current = entry.assigneeId ? ((await d.directory.get(entry.assigneeId))?.name ?? FORMER_MEMBER) : FORMER_MEMBER
    throw new HandoverError('conflict', `"${entry.topic}" is assigned to ${current} and still open. A new assignment waits until they complete it.`)
  }
  const back = `${HANDOVER_URL}#entry-${entry.id}`
  const context = [
    entry.sentence,
    '',
    `Status: ${STATUS_WORDS[entry.status]}`,
    ...(entry.link ? [`Details: ${entry.link}`] : []),
    `From the handover "${handover.title}": ${back}`,
  ].join('\n')
  const title = `Handover: ${entry.topic}`.slice(0, 200)
  // The brain's upkeep never assigns on its own: assigning is the owner's word (person or assistant).
  const via = actor.via === 'person' ? 'person' : 'assistant'
  const task = await d.tasks.assign({ userId: actor.userId, via }, { assigneeId: assignee.id, title, context })
  const at = nowOf(d)
  const updated = await d.store.updateEntry(entry.id, { assigneeId: assignee.id, assignedTaskId: task.id, updatedAt: at })
  if (!updated) throw new HandoverError('not_found', 'Handover entry not found.')
  await d.store.touchHandover(handover.id, at)
  return entryOut(d, updated)
}
