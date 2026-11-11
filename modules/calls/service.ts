import type { CallContextPort } from './context-port'
import { randomUUID } from 'node:crypto'
import { CallsError } from './errors'
import { mintRoomToken, type LiveKitConfig, type RoomControl } from './livekit'
import {
  accept,
  decline,
  forceEnd,
  hangup,
  inRoom,
  isLive,
  isRinging,
  joined,
  left,
  newCall,
  RING_TIMEOUT_MS,
  ringUntil,
  roomFinished,
  sameRecord,
  timeout,
} from './state'
import { CALL_CONTEXT_KINDS, type CallContextKind, type CallPerson, type CallRecord, type CallsDirectory, type CallsStore } from './store'

/**
 * Calls core (plan/video-calls.md §1). Starts calls for a DM, a channel or a
 * meeting; who may be in one is the context's business (CallContextPort →
 * Messages) or, for a meeting, its invite list. Membership is checked on
 * every action and a call someone may not see answers "not found" (fail
 * closed). Room tokens go to people only — never to an agent.
 */

export const MAX_MEETING_INVITEES = 50
export const MAX_TITLE = 200
export const LIST_LIMIT = 50

export type Actor = { kind: 'user'; userId: string } | { kind: 'agent'; id: string }

export type StartInput = {
  contextKind: CallContextKind
  /** The DM/channel conversation id; absent for a meeting. */
  contextId?: string | null
  /** A meeting's invitees. */
  userIds?: string[]
  /** A meeting's title (derived from the invitees when absent). */
  title?: string | null
}

export type CallsDeps = {
  store: CallsStore
  contexts: CallContextPort
  directory: CallsDirectory
  /** Read at use time; throws not_configured when LiveKit is not set up. */
  livekit: () => LiveKitConfig
  rooms: RoomControl
  now?: () => Date
  newId?: () => string
}

export type CallParticipantDto = {
  userId: string
  name: string
  response: 'accepted' | 'declined' | 'none'
  joinedAt: string | null
  leftAt: string | null
  inRoom: boolean
}

export type CallDto = {
  id: string
  contextKind: CallContextKind
  contextId: string | null
  title: string
  startedBy: string
  startedByName: string
  state: 'ringing' | 'active' | 'ended' | 'missed' | 'declined'
  startedAt: string
  /** When someone other than the caller first joined (the call's duration starts here). */
  answeredAt: string | null
  endedAt: string | null
  /** The ring window closes here (the incoming-call toast hides itself then). */
  ringUntil: string
  participants: CallParticipantDto[]
}

export type CallTokenDto = { url: string; room: string; identity: string; token: string; expiresAt: string }

/** What a LiveKit webhook means for a call (webhook.ts maps the signed event to this). */
export type CallWebhookEvent =
  | { kind: 'participant_joined' | 'participant_left'; room: string; identity: string }
  | { kind: 'room_finished'; room: string }

/** One person's view of a call: the DTO, and whether it is ringing for them. */
export type CallView = { call: CallDto; ringing: boolean }

export type CallsService = ReturnType<typeof createCallsService>

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const displayName = (p: CallPerson | undefined) => (p ? p.name.trim() || p.email : null)

export function createCallsService(d: CallsDeps) {
  const now = () => (d.now ? d.now() : new Date())
  const newId = () => (d.newId ? d.newId() : randomUUID())

  async function peopleById(): Promise<Map<string, CallPerson>> {
    return new Map((await d.directory.listPeople()).map((p) => [p.id, p]))
  }

  /** The record as of now: a ring window that closed reads as missed even before the sweep stores it. */
  const current = (rec: CallRecord) => timeout(rec, now())

  function dto(raw: CallRecord, people: Map<string, CallPerson>): CallDto {
    const rec = current(raw)
    const { call } = rec
    const answered = rec.participants
      .filter((p) => p.userId !== call.startedBy && p.joinedAt !== null)
      .map((p) => p.joinedAt!.getTime())
    return {
      id: call.id,
      contextKind: call.contextKind,
      contextId: call.contextId,
      title: call.title,
      startedBy: call.startedBy,
      startedByName: displayName(people.get(call.startedBy)) ?? 'Agent',
      state: call.state,
      startedAt: call.startedAt.toISOString(),
      answeredAt: answered.length > 0 ? new Date(Math.min(...answered)).toISOString() : null,
      endedAt: iso(call.endedAt),
      ringUntil: ringUntil(rec).toISOString(),
      participants: rec.participants.map((p) => ({
        userId: p.userId,
        name: displayName(people.get(p.userId)) ?? 'Former member',
        response: p.response,
        joinedAt: iso(p.joinedAt),
        leftAt: iso(p.leftAt),
        inRoom: inRoom(p),
      })),
    }
  }

  /** May this person be in (and see) this call right now? Fail closed. */
  async function eligible(userId: string, rec: CallRecord): Promise<boolean> {
    if (!(await d.directory.role(userId))) return false
    const { contextKind, contextId } = rec.call
    if (contextKind === 'meeting') return rec.participants.some((p) => p.userId === userId)
    if (contextId === null) return false
    return d.contexts.isMember(userId, contextKind, contextId)
  }

  /** A live call that just ended with people still in the room: close the room so LiveKit drops them. */
  async function afterChange(before: CallRecord, after: CallRecord): Promise<void> {
    if (isLive(before.call.state) && !isLive(after.call.state) && before.participants.some(inRoom)) {
      await d.rooms.closeRoom(after.call.roomName)
    }
  }

  async function mutate(id: string, change: (rec: CallRecord) => CallRecord): Promise<CallRecord> {
    const out = await d.store.mutate(id, change)
    if (!out) throw new CallsError('not_found', 'call not found')
    if (!sameRecord(out.before, out.after)) await afterChange(out.before, out.after)
    return out.after
  }

  /** Stores an elapsed ring window, then the call as the person may see it. */
  async function visible(userId: string, id: string): Promise<CallRecord> {
    const rec = await d.store.get(id)
    if (!rec || !(await eligible(userId, rec))) throw new CallsError('not_found', 'call not found')
    return rec.call.state === 'ringing' && current(rec) !== rec ? mutate(id, (r) => timeout(r, now())) : rec
  }

  async function act(userId: string, id: string, transition: (rec: CallRecord, userId: string, at: Date) => CallRecord) {
    await visible(userId, id)
    const after = await mutate(id, (r) => transition(r, userId, now()))
    return dto(after, await peopleById())
  }

  async function startMeeting(actor: Actor, input: StartInput): Promise<CallDto> {
    if (input.contextId) throw new CallsError('invalid', 'a meeting belongs to no conversation; pass the people to invite')
    const starter = actor.kind === 'user' ? actor.userId : actor.id
    const invitees = [...new Set(input.userIds ?? [])].filter((u) => u !== starter)
    if (invitees.length === 0) throw new CallsError('invalid', 'invite at least one person')
    if (invitees.length > MAX_MEETING_INVITEES) throw new CallsError('invalid', `a meeting has at most ${MAX_MEETING_INVITEES} invitees`)
    const people = await peopleById()
    const unknown: string[] = []
    for (const u of invitees) if (!people.has(u) || !(await d.directory.role(u))) unknown.push(u)
    if (unknown.length > 0) throw new CallsError('invalid', `unknown people: ${unknown.join(', ')}`)
    const typed = (input.title ?? '').trim()
    if (typed.length > MAX_TITLE) throw new CallsError('invalid', `a meeting title is at most ${MAX_TITLE} characters`)
    const title = typed || `Meeting with ${invitees.map((u) => displayName(people.get(u))).join(', ')}`.slice(0, MAX_TITLE)
    const id = newId()
    const rec = newCall({
      id,
      roomName: `ee-call-${id}`,
      contextKind: 'meeting',
      contextId: null,
      title,
      startedBy: starter,
      startedByParticipant: actor.kind === 'user',
      invitees,
      now: now(),
    })
    const res = await d.store.insert(rec)
    if (!res.ok) throw new Error(`calls: a meeting insert was refused as a context clash (${id})`)
    return dto(rec, people)
  }

  async function startInConversation(userId: string, kind: 'dm' | 'channel', input: StartInput): Promise<CallDto> {
    if ((input.userIds ?? []).length > 0 || input.title) {
      throw new CallsError('invalid', 'a DM or channel call rings its members; invite people to a meeting instead')
    }
    const contextId = input.contextId
    if (!contextId) throw new CallsError('invalid', 'which conversation? pass its id')
    const ctx = await d.contexts.open(userId, kind, contextId)
    if (!ctx) throw new CallsError('not_found', 'conversation not found')
    const others = [...new Set(ctx.memberIds)].filter((u) => u !== userId)
    if (others.length === 0) throw new CallsError('invalid', 'there is nobody else here to call')
    // Both people calling each other at once: the second start answers the first call.
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await d.store.liveForContext(kind, contextId)
      if (existing) return api.accept(userId, existing.call.id)
      const id = newId()
      const rec = newCall({
        id,
        roomName: `ee-call-${id}`,
        contextKind: kind,
        contextId,
        title: ctx.title.slice(0, MAX_TITLE),
        startedBy: userId,
        startedByParticipant: true,
        invitees: others,
        now: now(),
      })
      const res = await d.store.insert(rec)
      if (res.ok) return dto(rec, await peopleById())
      if (res.existing) return api.accept(userId, res.existing.call.id)
    }
    throw new CallsError('conflict', 'another call in this conversation is starting; try again')
  }

  const api = {
    async start(actor: Actor, input: StartInput): Promise<CallDto> {
      d.livekit() // fail loud before ringing anyone: nobody could join
      if (!(CALL_CONTEXT_KINDS as readonly string[]).includes(input.contextKind)) {
        throw new CallsError('invalid', 'contextKind is dm, channel or meeting')
      }
      if (actor.kind === 'user' && !(await d.directory.role(actor.userId))) {
        throw new CallsError('forbidden', 'only members of the company can start calls')
      }
      if (input.contextKind === 'meeting') return startMeeting(actor, input)
      if (actor.kind === 'agent') {
        throw new CallsError('forbidden', 'the agent starts meetings only; a DM or channel call is started by a person in it')
      }
      return startInConversation(actor.userId, input.contextKind, input)
    },

    accept: (userId: string, id: string) => act(userId, id, accept),
    decline: (userId: string, id: string) => act(userId, id, decline),
    hangup: (userId: string, id: string) => act(userId, id, hangup),

    /** calls.end: over for everyone. Only whoever started the call may. */
    async end(actor: Actor, id: string): Promise<CallDto> {
      const rec = await d.store.get(id)
      if (!rec) throw new CallsError('not_found', 'call not found')
      if (actor.kind === 'agent') {
        if (rec.call.startedBy !== actor.id) throw new CallsError('not_found', 'call not found')
      } else {
        if (!(await eligible(actor.userId, rec))) throw new CallsError('not_found', 'call not found')
        if (rec.call.startedBy !== actor.userId) {
          throw new CallsError('forbidden', 'only the person who started the call can end it for everyone; hang up to leave')
        }
      }
      return dto(await mutate(id, (r) => forceEnd(r, now())), await peopleById())
    },

    /** A LiveKit join token for this one room — people who accepted only. */
    async token(userId: string, id: string): Promise<CallTokenDto> {
      const cfg = d.livekit()
      const rec = await visible(userId, id)
      if (!isLive(rec.call.state)) throw new CallsError('conflict', 'this call is over')
      const p = rec.participants.find((x) => x.userId === userId)
      if (!p || p.response !== 'accepted') throw new CallsError('conflict', 'accept the call before joining it')
      const person = (await peopleById()).get(userId)
      const name = displayName(person)
      if (!name) throw new CallsError('not_found', 'call not found')
      const t = await mintRoomToken(cfg, { room: rec.call.roomName, identity: userId, name })
      return { url: cfg.url, room: rec.call.roomName, identity: userId, token: t.token, expiresAt: t.expiresAt.toISOString() }
    },

    async get(userId: string, id: string): Promise<CallDto> {
      return dto(await visible(userId, id), await peopleById())
    },

    /** A person's calls (newest first); the agent's: the meetings it started. */
    async list(actor: Actor, limit = LIST_LIMIT): Promise<CallDto[]> {
      const n = Math.min(Math.max(limit, 1), 200)
      const people = await peopleById()
      if (actor.kind === 'agent') return (await d.store.listStartedBy(actor.id, n)).map((r) => dto(r, people))
      const out: CallDto[] = []
      for (const r of await d.store.listForUser(actor.userId, n)) if (await eligible(actor.userId, r)) out.push(dto(r, people))
      return out
    },

    /** The person's view of a call for the live stream, or null when it is none of their business. */
    async viewFor(userId: string, rec: CallRecord, people?: Map<string, CallPerson>): Promise<CallView | null> {
      if (!rec.participants.some((p) => p.userId === userId)) return null
      if (!(await eligible(userId, rec))) return null
      return { call: dto(rec, people ?? (await peopleById())), ringing: isRinging(current(rec), userId, now()) }
    },

    /** Ringing/active calls of this person (the stream's snapshot on connect). */
    async liveViews(userId: string): Promise<CallView[]> {
      const people = await peopleById()
      const out: CallView[] = []
      for (const r of await d.store.liveForUser(userId)) {
        if (!isLive(current(r).call.state)) continue
        const v = await api.viewFor(userId, r, people)
        if (v) out.push(v)
      }
      return out
    },

    load: (id: string) => d.store.get(id),

    /** Stores every elapsed ring window as missed; returns how many calls changed. */
    async expireRinging(): Promise<number> {
      const ids = await d.store.ringingStartedBefore(new Date(now().getTime() - RING_TIMEOUT_MS))
      const errors: unknown[] = []
      let changed = 0
      for (const id of ids) {
        try {
          const out = await d.store.mutate(id, (r) => timeout(r, now()))
          if (out && !sameRecord(out.before, out.after)) {
            changed++
            await afterChange(out.before, out.after)
          }
        } catch (err) {
          errors.push(err)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, `calls: ${errors.length} of ${ids.length} ring timeouts failed`)
      return changed
    },

    /** The webhook's facts: who really joined and left. Unknown rooms and uninvited identities change nothing. */
    async applyWebhook(ev: CallWebhookEvent): Promise<{ applied: boolean }> {
      const rec = await d.store.getByRoom(ev.room)
      if (!rec) return { applied: false }
      let change: (r: CallRecord) => CallRecord
      if (ev.kind === 'room_finished') change = (r) => roomFinished(r, now())
      else {
        if (!rec.participants.some((p) => p.userId === ev.identity)) {
          console.warn('[calls] webhook for someone not invited to the call; ignored', { callId: rec.call.id, kind: ev.kind })
          return { applied: false }
        }
        change = ev.kind === 'participant_joined' ? (r) => joined(r, ev.identity, now()) : (r) => left(r, ev.identity, now())
      }
      const out = await d.store.mutate(rec.call.id, change)
      if (!out || sameRecord(out.before, out.after)) return { applied: false }
      await afterChange(out.before, out.after)
      return { applied: true }
    },
  }
  return api
}
