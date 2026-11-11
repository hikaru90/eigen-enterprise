import type { CallContextKind, CallRecord, CallState, Participant } from './store'
import { CallsError } from './errors'

/**
 * The call state machine — pure: every transition takes a record and returns
 * the next one (the same object when nothing changes). Client actions
 * (accept/decline/hangup) express intent; the LiveKit webhook
 * (joined/left/roomFinished) is the truth about who is really in the room.
 *
 *   ringing ─(someone other than the caller joins)→ active ─(last one out)→ ended
 *   ringing ─(ring window over / caller gives up)→ missed
 *   ringing ─(every invitee declines)→ declined
 */

/** How long a call rings before it counts as missed. */
export const RING_TIMEOUT_MS = 45_000

export const isLive = (s: CallState) => s === 'ringing' || s === 'active'
export const inRoom = (p: Participant) => p.joinedAt !== null && p.leftAt === null
export const ringUntil = (rec: CallRecord) => new Date(rec.call.startedAt.getTime() + RING_TIMEOUT_MS)

export type NewCallInput = {
  id: string
  roomName: string
  contextKind: CallContextKind
  contextId: string | null
  title: string
  startedBy: string
  /** A person starting a call is in it (accepted); an agent starting a meeting is not. */
  startedByParticipant: boolean
  invitees: string[]
  now: Date
}

export function newCall(i: NewCallInput): CallRecord {
  const row = (userId: string, response: Participant['response']): Participant => ({
    callId: i.id,
    userId,
    invitedAt: i.now,
    joinedAt: null,
    leftAt: null,
    response,
  })
  const invitees = [...new Set(i.invitees)].filter((u) => u !== i.startedBy)
  return {
    call: {
      id: i.id,
      roomName: i.roomName,
      contextKind: i.contextKind,
      contextId: i.contextId,
      title: i.title,
      startedBy: i.startedBy,
      state: 'ringing',
      startedAt: i.now,
      endedAt: null,
    },
    participants: [...(i.startedByParticipant ? [row(i.startedBy, 'accepted')] : []), ...invitees.map((u) => row(u, 'none'))],
  }
}

/** Whether this person's phone should be ringing for this call right now. */
export function isRinging(rec: CallRecord, userId: string, now: Date): boolean {
  if (!isLive(rec.call.state) || userId === rec.call.startedBy) return false
  if (now.getTime() >= ringUntil(rec).getTime()) return false
  const p = rec.participants.find((x) => x.userId === userId)
  return !!p && p.response === 'none' && !inRoom(p)
}

const participant = (rec: CallRecord, userId: string) => rec.participants.find((p) => p.userId === userId)

function patch(rec: CallRecord, userId: string, change: Partial<Participant>, now: Date): CallRecord {
  const existing = participant(rec, userId)
  const base: Participant = existing ?? { callId: rec.call.id, userId, invitedAt: now, joinedAt: null, leftAt: null, response: 'none' }
  const next = { ...base, ...change }
  return {
    call: rec.call,
    participants: existing ? rec.participants.map((p) => (p.userId === userId ? next : p)) : [...rec.participants, next],
  }
}

function finish(rec: CallRecord, state: CallState, now: Date): CallRecord {
  return {
    call: { ...rec.call, state, endedAt: now },
    participants: rec.participants.map((p) => (inRoom(p) ? { ...p, leftAt: now } : p)),
  }
}

const answered = (rec: CallRecord) => rec.participants.some((p) => p.userId !== rec.call.startedBy && p.joinedAt !== null)

/** Derives the call state from its participants after any change. */
function settle(rec: CallRecord, now: Date): CallRecord {
  const { call } = rec
  if (!isLive(call.state)) return rec
  const anyoneIn = rec.participants.some(inRoom)
  const invitees = rec.participants.filter((p) => p.userId !== call.startedBy)
  const starter = participant(rec, call.startedBy)
  let state: CallState = call.state
  if (answered(rec)) state = anyoneIn ? 'active' : 'ended'
  else if (invitees.length > 0 && invitees.every((p) => p.response === 'declined')) state = 'declined'
  else if (starter && starter.joinedAt !== null && !anyoneIn) state = 'missed' // the caller gave up
  if (state === call.state) return rec
  return isLive(state) ? { call: { ...call, state }, participants: rec.participants } : finish(rec, state, now)
}

/** The person says yes (or, when both call each other at once, the second caller joins the first call). */
export function accept(rec: CallRecord, userId: string, now: Date): CallRecord {
  if (!isLive(rec.call.state)) throw new CallsError('conflict', 'this call is over')
  if (participant(rec, userId)?.response === 'accepted') return rec
  return settle(patch(rec, userId, { response: 'accepted' }, now), now)
}

export function decline(rec: CallRecord, userId: string, now: Date): CallRecord {
  if (!isLive(rec.call.state)) return rec
  const p = participant(rec, userId)
  if (userId === rec.call.startedBy || (p && p.joinedAt !== null)) return hangup(rec, userId, now)
  if (p?.response === 'declined') return rec
  return settle(patch(rec, userId, { response: 'declined' }, now), now)
}

/** Leaving on purpose: the caller cancels a ringing call; a callee who never joined declines. */
export function hangup(rec: CallRecord, userId: string, now: Date): CallRecord {
  if (!isLive(rec.call.state)) return rec
  if (userId === rec.call.startedBy && !answered(rec)) return finish(rec, 'missed', now)
  const p = participant(rec, userId)
  if (!p) return rec
  // A DM is a two-person call: hanging up ends it for both (owner decision 2026-11-11).
  // A network drop is a webhook `left`, not a hang-up, so the other person waits for the reconnect.
  if (rec.call.contextKind === 'dm' && (p.joinedAt !== null || userId === rec.call.startedBy)) {
    return finish(rec, answered(rec) ? 'ended' : 'missed', now)
  }
  if (p.joinedAt === null) return userId === rec.call.startedBy ? rec : decline(rec, userId, now)
  if (!inRoom(p)) return rec
  return settle(patch(rec, userId, { leftAt: now }, now), now)
}

/** Webhook participant_joined. Only invited people count (fail closed). */
export function joined(rec: CallRecord, userId: string, now: Date): CallRecord {
  if (!isLive(rec.call.state)) return rec
  const p = participant(rec, userId)
  if (!p || inRoom(p)) return rec
  return settle(patch(rec, userId, { joinedAt: p.joinedAt ?? now, leftAt: null, response: 'accepted' }, now), now)
}

/** Webhook participant_left (or a connection that never completed). */
export function left(rec: CallRecord, userId: string, now: Date): CallRecord {
  if (!isLive(rec.call.state)) return rec
  const p = participant(rec, userId)
  if (!p || !inRoom(p)) return rec
  return settle(patch(rec, userId, { leftAt: now }, now), now)
}

/** Webhook room_finished: LiveKit closed the room. */
export function roomFinished(rec: CallRecord, now: Date): CallRecord {
  if (!isLive(rec.call.state)) return rec
  return finish(rec, answered(rec) ? 'ended' : 'missed', now)
}

/** The ring window closed and nobody answered. */
export function timeout(rec: CallRecord, now: Date): CallRecord {
  if (rec.call.state !== 'ringing' || now.getTime() < ringUntil(rec).getTime()) return rec
  return finish(rec, 'missed', now)
}

/** calls.end: the call is over for everyone. */
export function forceEnd(rec: CallRecord, now: Date): CallRecord {
  if (!isLive(rec.call.state)) return rec
  return finish(rec, answered(rec) ? 'ended' : 'missed', now)
}

const time = (d: Date | null) => (d ? d.getTime() : null)

/** Value equality of two records (participants compared by user id). */
export function sameRecord(a: CallRecord, b: CallRecord): boolean {
  if (a === b) return true
  const ca = a.call
  const cb = b.call
  if (
    ca.id !== cb.id ||
    ca.roomName !== cb.roomName ||
    ca.contextKind !== cb.contextKind ||
    ca.contextId !== cb.contextId ||
    ca.title !== cb.title ||
    ca.startedBy !== cb.startedBy ||
    ca.state !== cb.state ||
    time(ca.startedAt) !== time(cb.startedAt) ||
    time(ca.endedAt) !== time(cb.endedAt) ||
    a.participants.length !== b.participants.length
  ) {
    return false
  }
  return a.participants.every((pa) => {
    const pb = b.participants.find((x) => x.userId === pa.userId)
    return (
      !!pb &&
      pa.response === pb.response &&
      time(pa.invitedAt) === time(pb.invitedAt) &&
      time(pa.joinedAt) === time(pb.joinedAt) &&
      time(pa.leftAt) === time(pb.leftAt)
    )
  })
}
