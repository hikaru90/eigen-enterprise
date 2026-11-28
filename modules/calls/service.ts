import type { CallContextPort, CallLogPort } from './context-port'
import { randomUUID } from 'node:crypto'
import {
  brainListening,
  brainOff,
  brainOn,
  heardChat,
  brainTurnedOnBy,
  heardSegments,
  heardTranscriptText,
  heardTurns,
  MAX_BRAIN_ANSWER,
  MAX_BRAIN_QUESTION,
  openListen,
  shareBrainAnswer,
  type BrainAnswerStore,
  type CallBrain,
} from './brain'
import {
  CHAT_PAGE,
  chatTurns,
  parseChatBody,
  parseChatImage,
  type CallChatStore,
  type ChatImageInfo,
  type ChatImageUpload,
  type ChatMessage,
} from './chat'
import { CallsError } from './errors'
import {
  guestJoinUrl,
  guestLinkStatus,
  guestWindow,
  hashGuestToken,
  invitationEmail,
  newGuestToken,
  parseExternalUrl,
  parseGuestEmails,
  parseGuestName,
  parseTimeZone,
  scheduleOf,
  type GuestLinkStatus,
} from './guests'
import { mintGuestToken, mintRoomToken, type LiveKitConfig, type RoomControl } from './livekit'
import {
  accept,
  addGuests,
  decline,
  expireWindow,
  forceEnd,
  guestIdentity,
  hangup,
  inRoom,
  isLive,
  isRinging,
  isWindowed,
  joined,
  left,
  nameGuest,
  newCall,
  revokeGuest,
  RING_TIMEOUT_MS,
  setTranscribe,
  ringUntil,
  roomFinished,
  sameRecord,
  timeout,
  windowClosesAt,
  WINDOW_GRACE_MS,
} from './state'
import {
  CALL_CONTEXT_KINDS,
  type CallContextKind,
  type CallPerson,
  type CallRecord,
  type CallsDirectory,
  type CallsStore,
  type Guest,
} from './store'
import { MAX_CHUNK_BYTES, MAX_CHUNK_MS, MAX_SEGMENT_TEXT, mergeTurns, type TranscriptSegment, type TranscriptStore } from './transcript'

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
  /** Told once when a DM/channel call is over (its history line in the conversation). */
  log: CallLogPort
  directory: CallsDirectory
  /** Read at use time; throws not_configured when LiveKit is not set up. */
  livekit: () => LiveKitConfig
  rooms: RoomControl
  /** Company mail (the email module's transactional sending) for guest invitations. */
  mail: CallsMail
  /** The console's public origin (guest links), read at use time. */
  origin: () => string
  companyName: () => Promise<string | null>
  /** Call transcript segments (./transcript.ts). */
  transcripts: TranscriptStore
  /** Speech to text for one chunk (the gateway's transcription, on the company's provider in the live wiring). */
  speech: CallSpeech
  /** The Company Brain's answers and recaps (./brain.ts) — called only on an explicit ask. */
  brain: CallBrain
  /** The Brain's answers, private to their askers until shared. */
  brainAnswers: BrainAnswerStore
  /** The call's chat (./chat.ts): what the people in it write to each other. */
  chat: CallChatStore
  now?: () => Date
  newId?: () => string
}

/**
 * One chunk of someone's microphone → its text ("" = no speech). `userId` is
 * whom the usage is attributed to (the speaker; for a guest, the host). Throws
 * CallsError('unavailable') when the server has no speech-to-text set up.
 */
export type CallSpeech = (input: { userId: string; audio: { bytes: Uint8Array; format: string } }) => Promise<string>

/** One recorded chunk of a person's own microphone, as uploaded (never stored). */
export type TranscriptChunk = { bytes: Uint8Array; format: string; durationMs: number }

export type TranscriptSegmentDto = {
  seq: number
  speakerId: string
  speakerKind: 'member' | 'guest'
  speakerName: string
  startedAt: string
  endedAt: string
  text: string
}

/** One line of a call's chat, as the people in the call read it. */
export type CallChatMessageDto = {
  seq: number
  /** A user id, or guest:<id>. */
  authorId: string
  authorKind: 'member' | 'guest'
  authorName: string
  body: string
  /** A pasted image (wish 4fbf9991): its bytes via the chat's image route; the body is then empty. */
  image: ChatImageInfo | null
  createdAt: string
}

/** One read of a call's chat (arrival order); hasMore: read on from the last seq. */
export type CallChatPage = { messages: CallChatMessageDto[]; hasMore: boolean }

/** A call's transcript as someone who was in it reads it — with what was written in its chat. */
export type CallTranscriptDto = { call: CallDto; segments: TranscriptSegmentDto[]; chat: CallChatMessageDto[] }

/** What Calls needs from company mail (companyMail() from $lib/server/mail in the live wiring). */
export type CallsMail = {
  isConfigured(): Promise<boolean>
  send(input: { to: string; subject: string; html: string; text: string; replyTo?: string }): Promise<unknown>
}

/** A windowed meeting from the New call dialog (proposal 844bab56). */
export type ScheduleInput = {
  /** Colleagues to invite (company members). */
  userIds?: string[]
  /** Guests' email addresses (people outside the company). */
  guests?: unknown
  title?: string | null
  /** null / absent: now. */
  startsAt?: Date | null
  /** Default DEFAULT_DURATION_MINUTES. */
  durationMinutes?: number | null
  /** Another provider's call link (Zoom, Teams, Google Meet …): no room of our own. */
  externalUrl?: string | null
  /**
   * "Call now": start an instant call of our own with nobody invited yet; the
   * host invites guests and colleagues from inside the call (calls.invite_guests).
   * Only for now and on our own server.
   */
  inviteLater?: boolean
  /** The host's IANA time zone: the invitation shows times in it. */
  timeZone: unknown
}

export type GuestInvitation = {
  guestId: string
  email: string
  /** The personal guest link (or the other provider's link) — shown to the host once, to copy. */
  url: string
  emailed: boolean
  /** Why the email did not go out (sending failed); null when sent or when email is not set up. */
  error: string | null
}

export type ScheduleResult = {
  call: CallDto
  invitations: GuestInvitation[]
  /** Company email is set up; false → nothing was emailed, the links are there to copy. */
  mailConfigured: boolean
}

/** What the public guest page shows for a link. */
export type GuestPageView = {
  status: GuestLinkStatus
  title: string
  hostName: string
  companyName: string | null
  scheduledStart: string
  scheduledEnd: string
  opensAt: string
  closesAt: string
  /** The name the guest gave last time. */
  name: string | null
  /** The guest's participant id in the call (their LiveKit identity). */
  identity: string
}

export type GuestJoinDto = { identity: string; call: CallDto; token: CallTokenDto }

export type CallParticipantDto = {
  userId: string
  name: string
  /** Someone outside the company (shown "Guest"). */
  guest: boolean
  response: 'accepted' | 'declined' | 'none'
  joinedAt: string | null
  leftAt: string | null
  inRoom: boolean
  /** Their own microphone is transcribed (consent per person, on by default). */
  transcribing: boolean
}

export type CallDto = {
  id: string
  contextKind: CallContextKind
  contextId: string | null
  title: string
  startedBy: string
  startedByName: string
  state: 'scheduled' | 'ringing' | 'active' | 'ended' | 'missed' | 'declined'
  startedAt: string
  /** When someone other than the caller first joined (the call's duration starts here). */
  answeredAt: string | null
  endedAt: string | null
  /** The ring window closes here (the incoming-call toast hides itself then). */
  ringUntil: string
  participants: CallParticipantDto[]
  /** A windowed meeting's slot; null for calls that ring. */
  scheduledStart: string | null
  scheduledEnd: string | null
  /** When a windowed meeting closes for joining (scheduled end + 15 min). */
  closesAt: string | null
  /** Another provider's call link: join there. */
  externalUrl: string | null
  /** People invited from outside (empty in a guest's own view). */
  guests: CallGuestDto[]
  /** The Company Brain (off unless someone in the call switched it on). */
  brain: CallBrainDto
}

/** A Brain answer its asker shared with the call. */
export type SharedBrainAnswerDto = {
  id: string
  askedBy: string
  askedByName: string
  question: string
  answer: string
  askedAt: string
  sharedAt: string
}

/** The Company Brain in this call, as everyone in it sees it. */
export type CallBrainDto = {
  /** It is listening right now (the indicator everyone in the call sees). */
  listening: boolean
  /** Who switched it on (this stretch); null while off. */
  by: string | null
  byName: string | null
  since: string | null
  /** Members who switched it on in this call: the recap is offered to them. Empty in a guest's view. */
  turnedOnBy: string[]
  /** Answers shared with the call. Empty in a guest's view: the company's knowledge stays with its people. */
  shared: SharedBrainAnswerDto[]
}

/** One answer of the Brain, as its asker (alone) sees it. */
export type BrainAnswerDto = { id: string; question: string; answer: string; askedAt: string; shared: boolean }

export type CallGuestDto = { id: string; email: string; name: string | null; revoked: boolean; joined: boolean; inRoom: boolean }

export type CallTokenDto = { url: string; room: string; identity: string; token: string; expiresAt: string }

/** What a LiveKit webhook means for a call (webhook.ts maps the signed event to this). */
export type CallWebhookEvent =
  | { kind: 'participant_joined' | 'participant_left'; room: string; identity: string }
  | { kind: 'room_finished'; room: string }

/** One person's view of a call: the DTO, and whether it is ringing for them. */
export type CallView = { call: CallDto; ringing: boolean }

export type CallsService = ReturnType<typeof createCallsService>

const iso = (d: Date | null) => (d ? d.toISOString() : null)

const segmentDto = (s: TranscriptSegment): TranscriptSegmentDto => ({
  seq: s.seq,
  speakerId: s.speakerId,
  speakerKind: s.speakerKind,
  speakerName: s.speakerName,
  startedAt: s.startedAt.toISOString(),
  endedAt: s.endedAt.toISOString(),
  text: s.text,
})
const chatDto = (
  m: ChatMessage,
  images: ReadonlyMap<string, ChatImageInfo>,
): CallChatMessageDto => {
  const image = m.imageId ? images.get(m.imageId) : undefined
  if (m.imageId && !image)
    throw new Error(`calls: chat line ${m.seq} names image ${m.imageId}, which is not stored`)
  return {
    seq: m.seq,
    authorId: m.authorId,
    authorKind: m.authorKind,
    authorName: m.authorName,
    body: m.body,
    image: image ?? null,
    createdAt: m.createdAt.toISOString(),
  }
}

/** A chat cursor: absent (from the start) or a seq. */
function chatSince(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) throw new CallsError('invalid', 'since is a message seq (a whole number, 0 or more)')
  return raw
}

const displayName = (p: CallPerson | undefined) => (p ? p.name.trim() || p.email : null)

export function createCallsService(d: CallsDeps) {
  const now = () => (d.now ? d.now() : new Date())
  const newId = () => (d.newId ? d.newId() : randomUUID())

  async function peopleById(): Promise<Map<string, CallPerson>> {
    return new Map((await d.directory.listPeople()).map((p) => [p.id, p]))
  }

  /** The record as of now: a ring window (or meeting window) that closed reads as over even before the sweep stores it. */
  const current = (rec: CallRecord) => expireWindow(timeout(rec, now()), now())

  function dto(raw: CallRecord, people: Map<string, CallPerson>, opts: { forGuest?: boolean } = {}): CallDto {
    const rec = current(raw)
    const { call } = rec
    const guestsByIdentity = new Map(rec.guests.map((g) => [guestIdentity(g.id), g]))
    const participantOf = (userId: string) => rec.participants.find((p) => p.userId === userId)
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
      participants: rec.participants
        .filter((p) => !(opts.forGuest && guestsByIdentity.get(p.userId)?.revokedAt))
        .map((p) => {
          const g = guestsByIdentity.get(p.userId)
          return {
            userId: p.userId,
            name: g ? (g.displayName ?? (opts.forGuest ? 'Guest' : g.email)) : (displayName(people.get(p.userId)) ?? 'Former member'),
            guest: g !== undefined,
            response: p.response,
            joinedAt: iso(p.joinedAt),
            leftAt: iso(p.leftAt),
            inRoom: inRoom(p),
            transcribing: p.transcribe,
          }
        }),
      scheduledStart: iso(call.scheduledStart),
      scheduledEnd: iso(call.scheduledEnd),
      closesAt: isWindowed(rec) ? windowClosesAt(rec).toISOString() : null,
      externalUrl: call.externalUrl,
      guests: opts.forGuest
        ? []
        : rec.guests.map((g) => {
            const p = participantOf(guestIdentity(g.id))
            return { id: g.id, email: g.email, name: g.displayName, revoked: g.revokedAt !== null, joined: !!p?.joinedAt, inRoom: !!p && inRoom(p) }
          }),
      brain: brainDto(rec, people, opts),
    }
  }

  function brainDto(rec: CallRecord, people: Map<string, CallPerson>, opts: { forGuest?: boolean }): CallBrainDto {
    const open = brainListening(rec) ? openListen(rec) : null
    const nameOf = (userId: string) => displayName(people.get(userId)) ?? 'Former member'
    return {
      listening: open !== null,
      by: open?.onBy ?? null,
      byName: open ? nameOf(open.onBy) : null,
      since: open ? open.onAt.toISOString() : null,
      turnedOnBy: opts.forGuest ? [] : brainTurnedOnBy(rec),
      shared: opts.forGuest
        ? []
        : rec.brainShared.map((a) => ({
            id: a.id,
            askedBy: a.askedBy,
            askedByName: nameOf(a.askedBy),
            question: a.question,
            answer: a.answer,
            askedAt: a.askedAt.toISOString(),
            sharedAt: a.sharedAt.toISOString(),
          })),
    }
  }

  /** The Company Brain is for the company's people: guests (and anyone else) are refused before any call is read. */
  async function brainMember(userId: string): Promise<void> {
    if (!(await d.directory.role(userId))) throw new CallsError('forbidden', 'only people of the company can use the Company Brain')
  }

  /** In this live call right now (accepted it). */
  function inTheCall(rec: CallRecord, userId: string): void {
    if (!isLive(rec.call.state)) throw new CallsError('conflict', 'this call is over')
    const p = rec.participants.find((x) => x.userId === userId)
    if (!p || p.response !== 'accepted') throw new CallsError('conflict', 'join the call first')
  }

  /** Who was in the call, by name (guests marked) — for the Brain's prompt. */
  function peopleInCall(view: CallDto): string[] {
    return view.participants.filter((p) => p.joinedAt !== null).map((p) => (p.guest ? `${p.name} (guest)` : p.name))
  }

  /** What the Brain heard in this call (only while it listened) — said and written in its chat — as it reads it. */
  async function heardText(rec: CallRecord, view: CallDto): Promise<string> {
    const at = now()
    const heard = heardSegments(rec, await d.transcripts.list(rec.call.id), at)
    const written = heardChat(rec, await allChat(rec.call.id), at)
    return heardTranscriptText(mergeTurns(heardTurns(heard), chatTurns(written)), new Date(view.answeredAt ?? view.startedAt))
  }

  /** Every line of a call's chat (paged through the store). */
  async function allChat(callId: string): Promise<ChatMessage[]> {
    const out: ChatMessage[] = []
    for (;;) {
      const page = await d.chat.list(callId, out.at(-1)?.seq, CHAT_PAGE)
      out.push(...page)
      if (page.length < CHAT_PAGE) return out
    }
  }

  /** DTOs for chat lines, their images' display loaded once. */
  async function chatDtos(rows: ChatMessage[]): Promise<CallChatMessageDto[]> {
    const ids = rows.flatMap((m) => (m.imageId ? [m.imageId] : []))
    const images = ids.length > 0 ? await d.chat.imageInfo(ids) : new Map<string, ChatImageInfo>()
    return rows.map((m) => chatDto(m, images))
  }

  /** One read of a call's chat after `since`. */
  async function chatPage(callId: string, since: number | undefined): Promise<CallChatPage> {
    const rows = await d.chat.list(callId, since, CHAT_PAGE + 1)
    return { messages: await chatDtos(rows.slice(0, CHAT_PAGE)), hasMore: rows.length > CHAT_PAGE }
  }

  /** Stores a pasted image and its line (an image line has no text). */
  async function addImageLine(
    callId: string,
    author: { id: string; kind: 'member' | 'guest'; name: string },
    raw: ChatImageUpload,
  ): Promise<CallChatMessageDto> {
    const file = parseChatImage(raw)
    const imageId = newId()
    const at = now()
    await d.chat.addImage({
      id: imageId,
      callId,
      uploadedBy: author.id,
      name: file.name,
      mime: file.mime,
      size: file.bytes.byteLength,
      bytes: file.bytes,
      createdAt: at,
    })
    const line = await d.chat.add({
      callId,
      authorId: author.id,
      authorKind: author.kind,
      authorName: author.name,
      body: '',
      imageId,
      createdAt: at,
    })
    return (await chatDtos([line]))[0]!
  }

  async function imageOf(
    callId: string,
    imageId: string,
  ): Promise<{ mime: string; bytes: Uint8Array }> {
    const img = await d.chat.image(callId, imageId)
    if (!img) throw new CallsError('not_found', 'image not found')
    return { mime: img.mime, bytes: img.bytes }
  }

  /** A member may read a call's chat: in it now (accepted, live), or was in it (joined at least once). */
  function readsChat(rec: CallRecord, userId: string): boolean {
    const p = rec.participants.find((x) => x.userId === userId)
    if (!p) return false
    return p.joinedAt !== null || (isLive(rec.call.state) && p.response === 'accepted')
  }

  /** A call on another provider has no chat of ours. */
  function chatHere(rec: CallRecord): void {
    if (rec.call.externalUrl) throw new CallsError('conflict', 'this call takes place on another service')
  }

  /** A guest's link, usable now, of a guest who joined with a name. */
  async function chattingGuest(token: string): Promise<{ rec: CallRecord; guest: Guest & { displayName: string } }> {
    const { rec, guest } = await usableGuest(token)
    chatHere(rec)
    if (!guest.displayName) throw new CallsError('conflict', 'join the call first')
    return { rec, guest: { ...guest, displayName: guest.displayName } }
  }

  function parseQuestion(raw: unknown): string {
    if (typeof raw !== 'string') throw new CallsError('invalid', 'question is text')
    const q = raw.trim()
    if (q === '') throw new CallsError('invalid', 'ask a question')
    if (q.length > MAX_BRAIN_QUESTION) throw new CallsError('invalid', `a question is at most ${MAX_BRAIN_QUESTION} characters`)
    return q
  }

  /** May this person be in (and see) this call right now? Fail closed. */
  async function eligible(userId: string, rec: CallRecord): Promise<boolean> {
    if (!(await d.directory.role(userId))) return false
    const { contextKind, contextId } = rec.call
    if (contextKind === 'meeting') return rec.participants.some((p) => p.userId === userId)
    if (contextId === null) return false
    return d.contexts.isMember(userId, contextKind, contextId)
  }

  /** When a DM/channel call is over: the conversation's history line (meetings have none). */
  async function logEnded(rec: CallRecord): Promise<void> {
    const { call } = rec
    if (call.contextKind === 'meeting' || call.contextId === null) return
    const state = call.state
    if (state !== 'ended' && state !== 'missed' && state !== 'declined') throw new Error(`calls: ${call.id} is not over (${state})`)
    if (!call.endedAt) throw new Error(`calls: ${call.id} is over without an end time`)
    const answers = rec.participants.filter((p) => p.userId !== call.startedBy && p.joinedAt !== null).map((p) => p.joinedAt!.getTime())
    const durationSeconds =
      state === 'ended' && answers.length > 0 ? Math.max(0, Math.round((call.endedAt.getTime() - Math.min(...answers)) / 1000)) : null
    if (state === 'ended' && durationSeconds === null) throw new Error(`calls: ${call.id} ended without an answer`)
    await d.log.callEnded({
      callId: call.id,
      contextKind: call.contextKind,
      contextId: call.contextId,
      startedBy: call.startedBy,
      outcome: state,
      durationSeconds,
      endedAt: call.endedAt,
    })
  }

  /**
   * A live call that just ended: close the room (LiveKit drops whoever is
   * still in it) and log it in its conversation. Both run; any
   * failure is thrown after (the new state is already stored).
   */
  async function afterChange(before: CallRecord, after: CallRecord): Promise<void> {
    if (!isLive(before.call.state) || isLive(after.call.state)) return
    const errors: unknown[] = []
    // Always: the join webhook may not have arrived yet, and someone may already be in the room
    // (a decline right after the call starts). Closing a room that does not exist is a no-op.
    await d.rooms.closeRoom(after.call.roomName).catch((err: unknown) => errors.push(err))
    await logEnded(after).catch((err: unknown) => errors.push(err))
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, `calls: ${errors.length} follow-ups of ending ${after.call.id} failed`)
  }

  async function mutate(id: string, change: (rec: CallRecord) => CallRecord): Promise<CallRecord> {
    const out = await d.store.mutate(id, change)
    if (!out) throw new CallsError('not_found', 'call not found')
    if (!sameRecord(out.before, out.after)) await afterChange(out.before, out.after)
    return out.after
  }

  /** Stores an elapsed ring (or meeting) window, then the call as the person may see it. */
  async function visible(userId: string, id: string): Promise<CallRecord> {
    const rec = await d.store.get(id)
    if (!rec || !(await eligible(userId, rec))) throw new CallsError('not_found', 'call not found')
    return isLive(rec.call.state) && current(rec) !== rec ? mutate(id, (r) => current(r)) : rec
  }

  /** Invite these guests: their rows (token hashes only), then one email each (when mail is set up). */
  function inviteInto(
    rec: CallRecord,
    host: { id: string; name: string; email: string },
    emails: string[],
  ): { guests: Guest[]; links: Map<string, string> } {
    const at = now()
    const links = new Map<string, string>()
    const guests: Guest[] = emails.map((email) => {
      const { token, tokenHash } = newGuestToken()
      const id = newId()
      links.set(id, rec.call.externalUrl ?? guestJoinUrl(d.origin(), token))
      return { id, callId: rec.call.id, email, tokenHash, invitedBy: host.id, invitedAt: at, displayName: null, revokedAt: null }
    })
    return { guests, links }
  }

  async function sendInvitations(
    rec: CallRecord,
    host: { name: string; email: string },
    guests: Guest[],
    links: Map<string, string>,
    timeZone: string,
  ): Promise<{ invitations: GuestInvitation[]; mailConfigured: boolean }> {
    const mailConfigured = await d.mail.isConfigured()
    const companyName = await d.companyName()
    const invitations: GuestInvitation[] = []
    for (const g of guests) {
      const url = links.get(g.id)!
      if (!mailConfigured) {
        invitations.push({ guestId: g.id, email: g.email, url, emailed: false, error: null })
        continue
      }
      const mail = invitationEmail({
        companyName,
        hostName: host.name,
        title: rec.call.title,
        start: rec.call.scheduledStart!,
        end: rec.call.scheduledEnd!,
        timeZone,
        url,
        external: rec.call.externalUrl !== null,
      })
      try {
        await d.mail.send({ to: g.email, ...mail, replyTo: host.email })
        invitations.push({ guestId: g.id, email: g.email, url, emailed: true, error: null })
      } catch (err) {
        console.error('[calls] a guest invitation was not sent', { callId: rec.call.id, guestId: g.id, err })
        invitations.push({ guestId: g.id, email: g.email, url, emailed: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { invitations, mailConfigured }
  }

  /** The host (whoever started the call), as a person of the company. */
  async function hostOf(userId: string): Promise<{ id: string; name: string; email: string }> {
    const person = (await peopleById()).get(userId)
    if (!person || !(await d.directory.role(userId))) throw new CallsError('forbidden', 'only members of the company can invite guests')
    return { id: userId, name: displayName(person)!, email: person.email }
  }

  /** The guest a link belongs to, with their call; unknown links are not found. */
  async function guestByToken(token: string): Promise<{ rec: CallRecord; guest: Guest }> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw new CallsError('not_found', 'this link is not valid')
    const hash = hashGuestToken(token)
    const raw = await d.store.getByGuestTokenHash(hash)
    const guest = raw?.guests.find((g) => g.tokenHash === hash)
    if (!raw || !guest) throw new CallsError('not_found', 'this link is not valid')
    const rec = isLive(raw.call.state) && current(raw) !== raw ? await mutate(raw.call.id, (r) => current(r)) : raw
    return { rec, guest: rec.guests.find((g) => g.id === guest.id)! }
  }

  const GUEST_REFUSAL: Record<Exclude<GuestLinkStatus, 'ok'>, CallsError> = {
    too_early: new CallsError('conflict', 'this call has not opened yet'),
    expired: new CallsError('conflict', 'this guest link has expired'),
    over: new CallsError('conflict', 'this call is over'),
    revoked: new CallsError('forbidden', 'this guest link was withdrawn by the host'),
  }

  /** A guest's link that works right now (or the reason it does not). */
  async function usableGuest(token: string): Promise<{ rec: CallRecord; guest: Guest }> {
    const out = await guestByToken(token)
    const status = guestLinkStatus(out.rec, out.guest, now())
    if (status !== 'ok') throw GUEST_REFUSAL[status]
    return out
  }

  /** A chunk's shape: some audio, a duration the server can place on its clock. */
  function checkChunk(chunk: TranscriptChunk): void {
    if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.length === 0) throw new CallsError('invalid', 'the audio chunk is empty')
    if (chunk.bytes.length > MAX_CHUNK_BYTES) throw new CallsError('invalid', `an audio chunk is at most ${MAX_CHUNK_BYTES} bytes`)
    if (!Number.isInteger(chunk.durationMs) || chunk.durationMs <= 0 || chunk.durationMs > MAX_CHUNK_MS) {
      throw new CallsError('invalid', `an audio chunk lasts 1 ms to ${MAX_CHUNK_MS / 1000} s`)
    }
  }

  /** May this participant's microphone be transcribed right now? */
  function transcribable(rec: CallRecord, participantId: string): void {
    if (!isLive(rec.call.state)) throw new CallsError('conflict', 'this call is over')
    if (rec.call.externalUrl) throw new CallsError('conflict', 'this call takes place on another service')
    const p = rec.participants.find((x) => x.userId === participantId)
    if (!p || p.response !== 'accepted') throw new CallsError('conflict', 'join the call before sending audio')
    if (!p.transcribe) throw new CallsError('conflict', 'transcription of your microphone is off')
  }

  /**
   * The chunk's text, stored as one segment timed on the server's clock: it
   * ends when the chunk arrived (`receivedAt`, read before transcribing) and
   * starts `durationMs` before. The audio is passed on once and dropped.
   */
  async function transcribeInto(
    rec: CallRecord,
    speaker: { id: string; kind: 'member' | 'guest'; name: string; billedTo: string },
    chunk: TranscriptChunk,
    receivedAt: Date,
  ): Promise<{ segment: TranscriptSegmentDto | null }> {
    const text = (await d.speech({ userId: speaker.billedTo, audio: { bytes: chunk.bytes, format: chunk.format } })).trim()
    if (text === '') return { segment: null }
    const segment = await d.transcripts.add({
      callId: rec.call.id,
      speakerId: speaker.id,
      speakerKind: speaker.kind,
      speakerName: speaker.name.slice(0, 200),
      startedAt: new Date(receivedAt.getTime() - chunk.durationMs),
      endedAt: receivedAt,
      text: text.slice(0, MAX_SEGMENT_TEXT),
    })
    return { segment: segmentDto(segment) }
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
      if (rec.call.externalUrl) throw new CallsError('conflict', `this call takes place on another service: ${rec.call.externalUrl}`)
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

    /**
     * A windowed meeting from the New call dialog: colleagues and/or guests
     * (by email), now or booked, with a duration, optionally on another
     * provider. Each guest gets a personal link (returned once, to copy) and,
     * when company mail is set up, an invitation email.
     */
    async schedule(actor: Actor, input: ScheduleInput): Promise<ScheduleResult> {
      if (actor.kind !== 'user') throw new CallsError('forbidden', 'a person schedules meetings with guests')
      const externalUrl = input.externalUrl === undefined || input.externalUrl === null || input.externalUrl === '' ? null : parseExternalUrl(input.externalUrl)
      if (!externalUrl) d.livekit() // fail loud before inviting anyone: nobody could join
      const host = await hostOf(actor.userId)
      const timeZone = parseTimeZone(input.timeZone)
      const emails = input.guests === undefined ? [] : parseGuestEmails(input.guests)
      const window = scheduleOf({ startsAt: input.startsAt ?? null, durationMinutes: input.durationMinutes ?? null }, now())
      const people = await peopleById()
      const invitees = [...new Set(input.userIds ?? [])].filter((u) => u !== host.id)
      if (invitees.length > MAX_MEETING_INVITEES) throw new CallsError('invalid', `a meeting has at most ${MAX_MEETING_INVITEES} invitees`)
      const unknown: string[] = []
      for (const u of invitees) if (!people.has(u) || !(await d.directory.role(u))) unknown.push(u)
      if (unknown.length > 0) throw new CallsError('invalid', `unknown people: ${unknown.join(', ')}`)
      const alone = invitees.length === 0 && emails.length === 0
      if (alone) {
        if (!input.inviteLater) throw new CallsError('invalid', 'invite at least one guest or colleague')
        if (externalUrl || input.startsAt) throw new CallsError('invalid', 'a call with nobody invited yet can only start now, on our own call server')
      }
      const typed = (input.title ?? '').trim()
      if (typed.length > MAX_TITLE) throw new CallsError('invalid', `a meeting title is at most ${MAX_TITLE} characters`)
      const names = [...invitees.map((u) => displayName(people.get(u))!), ...emails]
      const title = typed || (alone ? 'Call' : `Meeting with ${names.join(', ')}`.slice(0, MAX_TITLE))
      const id = newId()
      const base = newCall({
        id,
        roomName: `ee-call-${id}`,
        contextKind: 'meeting',
        contextId: null,
        title,
        startedBy: host.id,
        startedByParticipant: true,
        invitees,
        now: now(),
        window,
        externalUrl,
      })
      const { guests, links } = inviteInto(base, host, emails)
      const rec = addGuests(base, guests, now())
      const res = await d.store.insert(rec)
      if (!res.ok) throw new Error(`calls: a meeting insert was refused as a context clash (${id})`)
      const sent = await sendInvitations(rec, host, guests, links, timeZone)
      return { call: dto(rec, people), ...sent }
    },

    /** The host invites more guests to a windowed meeting (an address already invited is skipped). */
    async inviteGuests(userId: string, id: string, input: { guests: unknown; timeZone: unknown }): Promise<ScheduleResult> {
      const rec = await visible(userId, id)
      if (rec.call.startedBy !== userId) throw new CallsError('forbidden', 'only the person who set up the meeting can invite guests')
      const host = await hostOf(userId)
      const timeZone = parseTimeZone(input.timeZone)
      const emails = parseGuestEmails(input.guests).filter((e) => !rec.guests.some((g) => g.email === e && !g.revokedAt))
      if (!isWindowed(rec)) throw new CallsError('invalid', 'guests can only be invited to a scheduled meeting')
      const { guests, links } = inviteInto(rec, host, emails)
      if (rec.guests.length + guests.length > 50) throw new CallsError('invalid', 'a meeting has at most 50 guest links')
      const after = guests.length > 0 ? await mutate(id, (r) => addGuests(r, guests, now())) : rec
      const sent = await sendInvitations(after, host, guests, links, timeZone)
      return { call: dto(after, await peopleById()), ...sent }
    },

    /** The host takes a guest's link back; a guest in the room is removed from it. */
    async revokeGuest(userId: string, id: string, guestId: string): Promise<CallDto> {
      const rec = await visible(userId, id)
      if (rec.call.startedBy !== userId) throw new CallsError('forbidden', 'only the person who set up the meeting can remove guests')
      if (!rec.guests.some((g) => g.id === guestId)) throw new CallsError('not_found', 'guest not found')
      const after = await mutate(id, (r) => revokeGuest(r, guestId, now()))
      const p = after.participants.find((x) => x.userId === guestIdentity(guestId))
      if (p && inRoom(p) && !after.call.externalUrl) await d.rooms.removeParticipant(after.call.roomName, guestIdentity(guestId))
      return dto(after, await peopleById())
    },

    /** What the public guest page shows for a link (unknown links: not_found). */
    async guestView(token: string): Promise<GuestPageView> {
      const { rec, guest } = await guestByToken(token)
      const status = guestLinkStatus(rec, guest, now())
      const { opensAt, closesAt } = guestWindow(rec.call)
      const people = await peopleById()
      return {
        status,
        title: rec.call.title,
        hostName: displayName(people.get(rec.call.startedBy)) ?? 'Your host',
        companyName: await d.companyName(),
        scheduledStart: rec.call.scheduledStart!.toISOString(),
        scheduledEnd: rec.call.scheduledEnd!.toISOString(),
        opensAt: opensAt.toISOString(),
        closesAt: closesAt.toISOString(),
        name: guest.displayName,
        identity: guestIdentity(guest.id),
      }
    },

    /** A guest joins with a display name: a LiveKit token for this one room (guest grants, inside the window only). */
    async guestJoin(token: string, rawName: unknown): Promise<GuestJoinDto> {
      const name = parseGuestName(rawName)
      const { rec, guest } = await usableGuest(token)
      if (rec.call.externalUrl) throw new CallsError('conflict', `this call takes place on another service: ${rec.call.externalUrl}`)
      const cfg = d.livekit()
      const after = await mutate(rec.call.id, (r) => nameGuest(r, guest.id, name))
      const identity = guestIdentity(guest.id)
      const t = await mintGuestToken(cfg, { room: after.call.roomName, identity, name, notAfter: windowClosesAt(after), now: now() })
      return {
        identity,
        call: dto(after, await peopleById(), { forGuest: true }),
        token: { url: cfg.url, room: after.call.roomName, identity, token: t.token, expiresAt: t.expiresAt.toISOString() },
      }
    },

    /** The call as the guest sees it (no one's email). A revoked or unknown link: not found. */
    async guestCall(token: string): Promise<CallDto> {
      const { rec, guest } = await guestByToken(token)
      if (guest.revokedAt) throw GUEST_REFUSAL.revoked
      return dto(rec, await peopleById(), { forGuest: true })
    },

    /** The guest's hang-up button: they leave the room (the meeting stays open). */
    async guestLeave(token: string): Promise<CallDto> {
      const { rec, guest } = await guestByToken(token)
      const after = await mutate(rec.call.id, (r) => hangup(r, guestIdentity(guest.id), now()))
      return dto(after, await peopleById(), { forGuest: true })
    },

    /** One ~30 s chunk of my own microphone → one segment of the call's transcript (null: no speech). */
    async transcribeChunk(userId: string, id: string, chunk: TranscriptChunk): Promise<{ segment: TranscriptSegmentDto | null }> {
      const receivedAt = now()
      checkChunk(chunk)
      const rec = await visible(userId, id)
      transcribable(rec, userId)
      const name = displayName((await peopleById()).get(userId))
      if (!name) throw new CallsError('not_found', 'call not found')
      return transcribeInto(rec, { id: userId, kind: 'member', name, billedTo: userId }, chunk, receivedAt)
    },

    /** A guest's chunk (their link is the proof). Billed to whoever set up the meeting. */
    async guestTranscribeChunk(token: string, chunk: TranscriptChunk): Promise<{ segment: TranscriptSegmentDto | null }> {
      const receivedAt = now()
      checkChunk(chunk)
      const { rec, guest } = await usableGuest(token)
      const identity = guestIdentity(guest.id)
      transcribable(rec, identity)
      if (!guest.displayName) throw new CallsError('conflict', 'join the call before sending audio')
      return transcribeInto(rec, { id: identity, kind: 'guest', name: guest.displayName, billedTo: rec.call.startedBy }, chunk, receivedAt)
    },

    /** I turn the transcription of my own microphone on or off (everyone in the call sees it). */
    async setTranscription(userId: string, id: string, on: boolean): Promise<CallDto> {
      if (typeof on !== 'boolean') throw new CallsError('invalid', 'on is true or false')
      await visible(userId, id)
      return dto(await mutate(id, (r) => setTranscribe(r, userId, on)), await peopleById())
    },

    async guestSetTranscription(token: string, on: boolean): Promise<CallDto> {
      if (typeof on !== 'boolean') throw new CallsError('invalid', 'on is true or false')
      const { rec, guest } = await usableGuest(token)
      const after = await mutate(rec.call.id, (r) => setTranscribe(r, guestIdentity(guest.id), on))
      return dto(after, await peopleById(), { forGuest: true })
    },

    /**
     * The call's transcript, merged by time — for people who were in the call
     * (joined it at least once). Someone who may see the call but never joined
     * is refused; anyone else does not see the call at all.
     */
    async transcript(userId: string, id: string): Promise<CallTranscriptDto> {
      const rec = await visible(userId, id)
      const p = rec.participants.find((x) => x.userId === userId)
      if (!p || p.joinedAt === null) throw new CallsError('forbidden', 'only people who were in the call can read its transcript')
      const segments = await d.transcripts.list(id)
      return {
        call: dto(rec, await peopleById()),
        segments: segments.map(segmentDto),
        chat: await chatDtos(await allChat(id)),
      }
    },

    /**
     * Transcript segments plus chat lines per call for my call list — only
     * calls I was in (the ones whose transcript, with its chat, I may read).
     */
    async transcriptCounts(userId: string, calls: CallDto[]): Promise<Record<string, number>> {
      const mine = calls.filter((c) => c.participants.some((p) => p.userId === userId && p.joinedAt !== null)).map((c) => c.id)
      const counts = await d.transcripts.countByCall(mine)
      for (const [callId, n] of await d.chat.countByCall(mine)) counts.set(callId, (counts.get(callId) ?? 0) + n)
      return Object.fromEntries(counts)
    },

    /** I write a line in the chat of the live call I am in (everyone in it reads it). */
    async postChat(userId: string, id: string, rawBody: unknown): Promise<CallChatMessageDto> {
      const body = parseChatBody(rawBody)
      const rec = await visible(userId, id)
      inTheCall(rec, userId)
      chatHere(rec)
      const name = displayName((await peopleById()).get(userId))
      if (!name) throw new CallsError('not_found', 'call not found')
      const line = await d.chat.add({
        callId: id,
        authorId: userId,
        authorKind: 'member',
        authorName: name.slice(0, 200),
        body,
        createdAt: now(),
      })
      return (await chatDtos([line]))[0]!
    },

    /** I paste an image in the chat of the live call I am in (wish 4fbf9991): a line of its own. */
    async postChatImage(
      userId: string,
      id: string,
      file: ChatImageUpload,
    ): Promise<CallChatMessageDto> {
      const rec = await visible(userId, id)
      inTheCall(rec, userId)
      chatHere(rec)
      const name = displayName((await peopleById()).get(userId))
      if (!name) throw new CallsError('not_found', 'call not found')
      return addImageLine(id, { id: userId, kind: 'member', name: name.slice(0, 200) }, file)
    },

    /** An image of the call's chat, for whoever reads that chat. */
    async chatImage(
      userId: string,
      id: string,
      imageId: string,
    ): Promise<{ mime: string; bytes: Uint8Array }> {
      const rec = await visible(userId, id)
      if (!readsChat(rec, userId)) throw new CallsError('not_found', 'image not found')
      return imageOf(id, imageId)
    },

    /** The call's chat (arrival order, after `since`): for people in the call now or who were in it. */
    async chat(userId: string, id: string, since?: unknown): Promise<CallChatPage> {
      const after = chatSince(since)
      const rec = await visible(userId, id)
      if (!readsChat(rec, userId)) throw new CallsError('forbidden', 'only people in the call read its chat')
      return chatPage(id, after)
    },

    /** A guest writes in the chat — as their guest name, only while they are in the room. */
    async guestPostChat(token: string, rawBody: unknown): Promise<CallChatMessageDto> {
      const body = parseChatBody(rawBody)
      const { rec, guest } = await chattingGuest(token)
      const identity = guestIdentity(guest.id)
      const p = rec.participants.find((x) => x.userId === identity)
      if (!p || !inRoom(p))
        throw new CallsError('conflict', 'join the call before writing in its chat')
      const line = await d.chat.add({
        callId: rec.call.id,
        authorId: identity,
        authorKind: 'guest',
        authorName: guest.displayName,
        body,
        createdAt: now(),
      })
      return (await chatDtos([line]))[0]!
    },

    /** The guest pastes an image (wish 4fbf9991) — only while they are in the room. */
    async guestPostChatImage(token: string, file: ChatImageUpload): Promise<CallChatMessageDto> {
      const { rec, guest } = await chattingGuest(token)
      const identity = guestIdentity(guest.id)
      const p = rec.participants.find((x) => x.userId === identity)
      if (!p || !inRoom(p))
        throw new CallsError('conflict', 'join the call before writing in its chat')
      return addImageLine(
        rec.call.id,
        { id: identity, kind: 'guest', name: guest.displayName },
        file,
      )
    },

    /** An image of the chat, as the guest reads it (while their link works). */
    async guestChatImage(
      token: string,
      imageId: string,
    ): Promise<{ mime: string; bytes: Uint8Array }> {
      const { rec } = await chattingGuest(token)
      return imageOf(rec.call.id, imageId)
    },

    /** The chat as a guest reads it: while their link works, once they joined with a name. */
    async guestChat(token: string, since?: unknown): Promise<CallChatPage> {
      const after = chatSince(since)
      const { rec } = await chattingGuest(token)
      return chatPage(rec.call.id, after)
    },

    /** One chat line by its seq, no access check — for the live stream, which checks each reader (canReadChat). */
    chatMessage: async (seq: number): Promise<{ callId: string; message: CallChatMessageDto } | null> => {
      const m = await d.chat.get(seq)
      return m ? { callId: m.callId, message: (await chatDtos([m]))[0]! } : null
    },

    /** May this person read this call's chat on the live stream? (Guests read through their link, never the stream.) */
    async canReadChat(userId: string, rec: CallRecord): Promise<boolean> {
      if (!readsChat(rec, userId)) return false
      return eligible(userId, rec)
    },

    /**
     * A call's segments merged by time; with `since` (a seq), only what
     * arrived after it — for a reader that follows a call live (the Company
     * Brain listening in, a follow-up). NO access check: it is for the
     * company's own server-side readers; anything a person asks for goes
     * through transcript().
     */
    listTranscriptSegments: (callId: string, since?: number): Promise<TranscriptSegment[]> => d.transcripts.list(callId, since),

    /**
     * Company Brain: switch it on (a member in the live call) or off (anyone
     * in it). Everyone in the call sees the change. Nothing is answered here.
     */
    async setBrain(userId: string, id: string, on: boolean): Promise<CallDto> {
      if (typeof on !== 'boolean') throw new CallsError('invalid', 'on is true or false')
      await brainMember(userId)
      const rec = await visible(userId, id)
      inTheCall(rec, userId)
      const after = await mutate(id, (r) => (on ? brainOn(r, userId, now(), newId()) : brainOff(r, userId, now())))
      return dto(after, await peopleById())
    },

    /**
     * Someone in the call asks the Brain (the only way it ever answers): from
     * what it heard while listening and the asker's own Memory, run as the
     * asker. The answer is theirs alone until they share it.
     */
    async askBrain(userId: string, id: string, rawQuestion: unknown): Promise<BrainAnswerDto> {
      const question = parseQuestion(rawQuestion)
      await brainMember(userId)
      const rec = await visible(userId, id)
      inTheCall(rec, userId)
      if (!brainListening(rec)) throw new CallsError('conflict', 'the Company Brain is not listening to this call; switch it on first')
      const people = await peopleById()
      const askerName = displayName(people.get(userId))
      if (!askerName) throw new CallsError('not_found', 'call not found')
      const view = dto(rec, people)
      const heard = await heardText(rec, view)
      const text = (await d.brain.answer({ askerId: userId, askerName, question, callTitle: rec.call.title, people: peopleInCall(view), heard })).trim()
      if (text === '') throw new Error(`calls: the Company Brain gave an empty answer (${id})`)
      const answer = { id: newId(), callId: id, askedBy: userId, question, answer: text.slice(0, MAX_BRAIN_ANSWER), askedAt: now() }
      await d.brainAnswers.add(answer)
      return { id: answer.id, question, answer: answer.answer, askedAt: answer.askedAt.toISOString(), shared: false }
    },

    /** My own answers in this call (the panel after a reload). */
    async myBrainAnswers(userId: string, id: string): Promise<BrainAnswerDto[]> {
      await brainMember(userId)
      const rec = await visible(userId, id)
      return (await d.brainAnswers.listMine(id, userId)).map((a) => ({
        id: a.id,
        question: a.question,
        answer: a.answer,
        askedAt: a.askedAt.toISOString(),
        shared: rec.brainShared.some((s) => s.id === a.id),
      }))
    },

    /** The asker shares one of their answers with the colleagues in the call (labelled: the Brain, asked by them). */
    async shareBrainAnswer(userId: string, id: string, answerId: unknown): Promise<CallDto> {
      if (typeof answerId !== 'string') throw new CallsError('invalid', 'answerId is text')
      await brainMember(userId)
      await visible(userId, id)
      const a = await d.brainAnswers.get(answerId)
      if (!a || a.callId !== id || a.askedBy !== userId) throw new CallsError('not_found', 'answer not found')
      const shared = { id: a.id, callId: a.callId, askedBy: a.askedBy, question: a.question, answer: a.answer, askedAt: a.askedAt }
      const after = await mutate(id, (r) => shareBrainAnswer(r, shared, now()))
      return dto(after, await peopleById())
    },

    /**
     * After the call: a recap of what the Brain heard — generated now, on this
     * request, for someone who switched it on; shown to them, posted nowhere.
     */
    async brainRecap(userId: string, id: string): Promise<{ recap: string }> {
      await brainMember(userId)
      const rec = await visible(userId, id)
      if (isLive(rec.call.state)) throw new CallsError('conflict', 'the recap is there once the call is over')
      if (!brainTurnedOnBy(rec).includes(userId)) throw new CallsError('forbidden', 'the recap is offered to whoever switched the Company Brain on')
      const view = dto(rec, await peopleById())
      const heard = await heardText(rec, view)
      if (heard === '') throw new CallsError('conflict', 'the Company Brain heard nothing in this call')
      const recap = (await d.brain.recap({ userId, callTitle: rec.call.title, people: peopleInCall(view), heard })).trim()
      if (recap === '') throw new Error(`calls: the Company Brain gave an empty recap (${id})`)
      await d.brainAnswers.saveRecap(id, userId, recap, now())
      return { recap }
    },

    /**
     * My /calls rows' summary (wish 397dfda6): per call I may recap (over, and I
     * switched the Company Brain on in it) the recap I already made, or null —
     * then the row offers "Make summary". Calls I may not recap are absent.
     */
    async recapsForList(userId: string, calls: CallDto[]): Promise<Record<string, string | null>> {
      const offered = calls
        .filter((c) => !isLive(c.state) && c.brain.turnedOnBy.includes(userId))
        .map((c) => c.id)
      const kept = await d.brainAnswers.recapsFor(userId, offered)
      return Object.fromEntries(offered.map((id) => [id, kept.get(id) ?? null]))
    },

    /** Stores every windowed meeting whose window closed with nobody in it as over; returns how many changed. */
    async expireWindows(): Promise<number> {
      const ids = await d.store.windowsEndedBefore(new Date(now().getTime() - WINDOW_GRACE_MS))
      const errors: unknown[] = []
      let changed = 0
      for (const id of ids) {
        try {
          const out = await d.store.mutate(id, (r) => expireWindow(r, now()))
          if (out && !sameRecord(out.before, out.after)) {
            changed++
            await afterChange(out.before, out.after)
          }
        } catch (err) {
          errors.push(err)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, `calls: ${errors.length} of ${ids.length} meeting windows failed to close`)
      return changed
    },

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
