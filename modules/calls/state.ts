import type { CallContextKind, CallRecord, CallState, Guest, Participant } from './store'
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
 *
 * A windowed meeting (booked, or started now with guests — proposal
 * 844bab56) does not ring out: it is open for joining until its window
 * closes (scheduled end + WINDOW_GRACE_MS). People come and go; declines,
 * the host leaving and LiveKit closing an empty room do not end it.
 *
 *   scheduled ─(anyone joins)→ active ─(last one out)→ scheduled
 *   scheduled ─(window closed)→ ended (somebody came) / missed (nobody did)
 *   active ─(last one out after the window closed)→ ended
 */

/** How long a call rings before it counts as missed. */
export const RING_TIMEOUT_MS = 45_000

/** A guest link opens this long before a windowed meeting's start (owner proposal: a buffer around the slot). */
export const WINDOW_EARLY_MS = 15 * 60_000
/** A windowed meeting (and its guest links) stays open this long after its scheduled end. */
export const WINDOW_GRACE_MS = 15 * 60_000

export const isLive = (s: CallState) => s === 'scheduled' || s === 'ringing' || s === 'active'
export const inRoom = (p: Participant) => p.joinedAt !== null && p.leftAt === null
export const ringUntil = (rec: CallRecord) => new Date(rec.call.startedAt.getTime() + RING_TIMEOUT_MS)

/** A guest's participant id and LiveKit identity (never a user id: those have no colon). */
export const guestIdentity = (guestId: string) => `guest:${guestId}`

export const isWindowed = (rec: CallRecord) => rec.call.scheduledEnd !== null

/** When a windowed meeting closes for joining (scheduled end + grace). */
export function windowClosesAt(rec: CallRecord): Date {
  if (!rec.call.scheduledEnd) throw new Error(`calls: ${rec.call.id} has no window`)
  return new Date(rec.call.scheduledEnd.getTime() + WINDOW_GRACE_MS)
}

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
  /** A windowed meeting's slot (meetings only); absent: a call that rings. */
  window?: { start: Date; end: Date } | null
  /** Another provider's call link (windowed meetings only). */
  externalUrl?: string | null
}

export function newCall(i: NewCallInput): CallRecord {
  const row = (userId: string, response: Participant['response']): Participant => ({
    callId: i.id,
    userId,
    invitedAt: i.now,
    joinedAt: null,
    leftAt: null,
    response,
    transcribe: true,
  })
  const invitees = [...new Set(i.invitees)].filter((u) => u !== i.startedBy)
  const window = i.window ?? null
  if (window && i.contextKind !== 'meeting') throw new CallsError('invalid', 'only a meeting has a time slot')
  if (window && window.end.getTime() <= window.start.getTime()) throw new CallsError('invalid', 'a meeting ends after it starts')
  if (i.externalUrl && !window) throw new Error('calls: another provider’s link needs a windowed meeting')
  return {
    call: {
      id: i.id,
      roomName: i.roomName,
      contextKind: i.contextKind,
      contextId: i.contextId,
      title: i.title,
      startedBy: i.startedBy,
      state: window ? 'scheduled' : 'ringing',
      startedAt: i.now,
      endedAt: null,
      scheduledStart: window?.start ?? null,
      scheduledEnd: window?.end ?? null,
      externalUrl: i.externalUrl ?? null,
    },
    participants: [...(i.startedByParticipant ? [row(i.startedBy, 'accepted')] : []), ...invitees.map((u) => row(u, 'none'))],
    guests: [],
  }
}

/** Invite guests to a windowed meeting: each gets an accepted participant row (they are never rung). */
export function addGuests(rec: CallRecord, guests: Guest[], now: Date): CallRecord {
  if (!isWindowed(rec)) throw new CallsError('invalid', 'guests can only be invited to a scheduled meeting')
  if (!isLive(rec.call.state)) throw new CallsError('conflict', 'this call is over')
  for (const g of guests) {
    if (g.callId !== rec.call.id) throw new Error(`calls: guest ${g.id} belongs to another call`)
    if (rec.guests.some((x) => x.id === g.id)) throw new Error(`calls: guest ${g.id} is already invited`)
  }
  const rows: Participant[] = guests.map((g) => ({
    callId: rec.call.id,
    userId: guestIdentity(g.id),
    invitedAt: now,
    joinedAt: null,
    leftAt: null,
    response: 'accepted',
    transcribe: true,
  }))
  return { call: rec.call, participants: [...rec.participants, ...rows], guests: [...rec.guests, ...guests] }
}

/** The name a guest gave on the guest page. */
export function nameGuest(rec: CallRecord, guestId: string, name: string): CallRecord {
  const g = rec.guests.find((x) => x.id === guestId)
  if (!g) throw new CallsError('not_found', 'guest not found')
  if (g.displayName === name) return rec
  return { ...rec, guests: rec.guests.map((x) => (x.id === guestId ? { ...x, displayName: name } : x)) }
}

/** The host takes a guest's link back (whoever is in the room is removed by the service). */
export function revokeGuest(rec: CallRecord, guestId: string, now: Date): CallRecord {
  const g = rec.guests.find((x) => x.id === guestId)
  if (!g) throw new CallsError('not_found', 'guest not found')
  if (g.revokedAt) return rec
  return { ...rec, guests: rec.guests.map((x) => (x.id === guestId ? { ...x, revokedAt: now } : x)) }
}

/**
 * A person turns the transcription of their own microphone on or off (call
 * transcripts: consent per person, on by default). Only in a live call.
 */
export function setTranscribe(rec: CallRecord, userId: string, on: boolean): CallRecord {
  if (!isLive(rec.call.state)) throw new CallsError('conflict', 'this call is over')
  const p = participant(rec, userId)
  if (!p) throw new CallsError('not_found', 'call not found')
  if (p.transcribe === on) return rec
  return { ...rec, participants: rec.participants.map((x) => (x.userId === userId ? { ...x, transcribe: on } : x)) }
}

/** A windowed meeting whose window closed while nobody is in: over. */
export function expireWindow(rec: CallRecord, now: Date): CallRecord {
  if (!isWindowed(rec) || !isLive(rec.call.state)) return rec
  return settle(rec, now)
}

/** Whether this person's phone should be ringing for this call right now. */
export function isRinging(rec: CallRecord, userId: string, now: Date): boolean {
  if (!isLive(rec.call.state) || userId === rec.call.startedBy) return false
  // A windowed meeting rings its colleagues only when it starts right away on our own server.
  const { scheduledStart, externalUrl, startedAt } = rec.call
  if (scheduledStart && (externalUrl !== null || scheduledStart.getTime() > startedAt.getTime())) return false
  if (now.getTime() >= ringUntil(rec).getTime()) return false
  const p = rec.participants.find((x) => x.userId === userId)
  return !!p && p.response === 'none' && !inRoom(p)
}

const participant = (rec: CallRecord, userId: string) => rec.participants.find((p) => p.userId === userId)

function patch(rec: CallRecord, userId: string, change: Partial<Participant>, now: Date): CallRecord {
  const existing = participant(rec, userId)
  const base: Participant = existing ?? { callId: rec.call.id, userId, invitedAt: now, joinedAt: null, leftAt: null, response: 'none', transcribe: true }
  const next = { ...base, ...change }
  return {
    call: rec.call,
    participants: existing ? rec.participants.map((p) => (p.userId === userId ? next : p)) : [...rec.participants, next],
    guests: rec.guests,
  }
}

function finish(rec: CallRecord, state: CallState, now: Date): CallRecord {
  return {
    call: { ...rec.call, state, endedAt: now },
    participants: rec.participants.map((p) => (inRoom(p) ? { ...p, leftAt: now } : p)),
    guests: rec.guests,
  }
}

const everJoined = (rec: CallRecord) => rec.participants.some((p) => p.joinedAt !== null)

/** A windowed meeting's state from who is in and the clock. */
function settleWindow(rec: CallRecord, now: Date): CallRecord {
  const { call } = rec
  if (rec.participants.some(inRoom)) return call.state === 'active' ? rec : { ...rec, call: { ...call, state: 'active' } }
  if (now.getTime() >= windowClosesAt(rec).getTime()) return finish(rec, everJoined(rec) ? 'ended' : 'missed', now)
  return call.state === 'scheduled' ? rec : { ...rec, call: { ...call, state: 'scheduled' } }
}

const answered = (rec: CallRecord) => rec.participants.some((p) => p.userId !== rec.call.startedBy && p.joinedAt !== null)

/** Derives the call state from its participants after any change. */
function settle(rec: CallRecord, now: Date): CallRecord {
  const { call } = rec
  if (!isLive(call.state)) return rec
  if (isWindowed(rec)) return settleWindow(rec, now)
  const anyoneIn = rec.participants.some(inRoom)
  const invitees = rec.participants.filter((p) => p.userId !== call.startedBy)
  const starter = participant(rec, call.startedBy)
  let state: CallState = call.state
  if (answered(rec)) state = anyoneIn ? 'active' : 'ended'
  else if (invitees.length > 0 && invitees.every((p) => p.response === 'declined')) state = 'declined'
  else if (starter && starter.joinedAt !== null && !anyoneIn) state = 'missed' // the caller gave up
  if (state === call.state) return rec
  return isLive(state) ? { ...rec, call: { ...call, state } } : finish(rec, state, now)
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
  if (isWindowed(rec)) {
    if (!p) return rec
    if (inRoom(p)) return hangup(rec, userId, now)
    return p.response === 'declined' || userId === rec.call.startedBy ? rec : settle(patch(rec, userId, { response: 'declined' }, now), now)
  }
  if (userId === rec.call.startedBy || (p && p.joinedAt !== null)) return hangup(rec, userId, now)
  if (p?.response === 'declined') return rec
  return settle(patch(rec, userId, { response: 'declined' }, now), now)
}

/** Leaving on purpose: the caller cancels a ringing call; a callee who never joined declines. */
export function hangup(rec: CallRecord, userId: string, now: Date): CallRecord {
  if (!isLive(rec.call.state)) return rec
  if (isWindowed(rec)) {
    // Leaving a booked meeting is leaving the room: it stays open for the others and for coming back.
    const p = participant(rec, userId)
    return p && inRoom(p) ? settle(patch(rec, userId, { leftAt: now }, now), now) : rec
  }
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
  if (isWindowed(rec)) {
    // LiveKit closes an empty room; the meeting stays open until its window closes (a join opens a new room).
    return settle({ ...rec, participants: rec.participants.map((p) => (inRoom(p) ? { ...p, leftAt: now } : p)) }, now)
  }
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
    time(ca.scheduledStart) !== time(cb.scheduledStart) ||
    time(ca.scheduledEnd) !== time(cb.scheduledEnd) ||
    ca.externalUrl !== cb.externalUrl ||
    a.participants.length !== b.participants.length ||
    a.guests.length !== b.guests.length
  ) {
    return false
  }
  const sameGuests = a.guests.every((ga) => {
    const gb = b.guests.find((x) => x.id === ga.id)
    return (
      !!gb &&
      ga.email === gb.email &&
      ga.tokenHash === gb.tokenHash &&
      ga.displayName === gb.displayName &&
      time(ga.invitedAt) === time(gb.invitedAt) &&
      time(ga.revokedAt) === time(gb.revokedAt)
    )
  })
  if (!sameGuests) return false
  return a.participants.every((pa) => {
    const pb = b.participants.find((x) => x.userId === pa.userId)
    return (
      !!pb &&
      pa.response === pb.response &&
      pa.transcribe === pb.transcribe &&
      time(pa.invitedAt) === time(pb.invitedAt) &&
      time(pa.joinedAt) === time(pb.joinedAt) &&
      time(pa.leftAt) === time(pb.leftAt)
    )
  })
}
