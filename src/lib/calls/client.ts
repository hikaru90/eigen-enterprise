import type {
  BrainAnswerDto,
  CallBrainDto,
  CallChatMessageDto,
  CallChatPage,
  CallDto,
  CallTokenDto,
  GuestJoinDto,
  ScheduleResult,
  SharedBrainAnswerDto,
  TranscriptSegmentDto,
} from '../../../modules/calls/service'
import type { ShownError } from '$lib/errors/agent-report'
import { problemFromResponse, type CallProblem } from './call-state'

/**
 * The browser's side of /api/calls (plan/video-calls.md §1 http). A refused
 * request throws CallRequestError carrying the problem decided by the
 * server's error code (e.g. not_configured → "Calls are not set up on this
 * server", shown as the server says it).
 */

export type {
  BrainAnswerDto,
  CallBrainDto,
  CallChatMessageDto,
  CallChatPage,
  CallDto,
  CallTokenDto,
  GuestJoinDto,
  ScheduleResult,
  SharedBrainAnswerDto,
  TranscriptSegmentDto,
}

/** The New call dialog's request (POST /api/calls/meetings). */
export type ScheduleCall = {
  guests: string[]
  userIds: string[]
  title: string | null
  /** ISO time; null = now. */
  startsAt: string | null
  durationMinutes: number
  externalUrl: string | null
  /** Call now with nobody invited yet: people are invited from inside the call. */
  inviteLater?: boolean
  timeZone: string
}
export type StartCall =
  | { contextKind: 'dm' | 'channel'; contextId: string }
  | { contextKind: 'meeting'; userIds: string[]; title?: string | null }

export class CallRequestError extends Error {
  constructor(readonly problem: CallProblem) {
    super(problem.message)
    this.name = 'CallRequestError'
  }
}

export type CallsClient = {
  start(input: StartCall): Promise<CallDto>
  get(id: string): Promise<CallDto>
  accept(id: string): Promise<CallDto>
  decline(id: string): Promise<CallDto>
  /** keepalive: still delivered while the page unloads (closing the tab mid-call). */
  hangup(id: string, opts?: { keepalive?: boolean }): Promise<CallDto>
  token(id: string): Promise<CallTokenDto>
  schedule(input: ScheduleCall): Promise<ScheduleResult>
  inviteGuests(id: string, guests: string[], timeZone: string): Promise<ScheduleResult>
  revokeGuest(id: string, guestId: string): Promise<CallDto>
  /** One chunk of my own microphone (call transcripts): its segment, or null when it held no speech. */
  transcribe(id: string, chunk: Blob, durationMs: number): Promise<TranscriptSegmentDto | null>
  /** Turn the transcription of my own microphone on or off. */
  setTranscription(id: string, on: boolean): Promise<CallDto>
}

/** The Company Brain in a call (members only — a guest has none of these). */
export type BrainClient = {
  /** Switch it on or off for everyone in the call. */
  setBrain(id: string, on: boolean): Promise<CallDto>
  /** Ask it; the answer is mine alone. */
  askBrain(id: string, question: string): Promise<BrainAnswerDto>
  /** My own answers in this call. */
  myBrainAnswers(id: string): Promise<BrainAnswerDto[]>
  /** Share one of my answers with the colleagues in the call. */
  shareBrainAnswer(id: string, answerId: string): Promise<CallDto>
  /** After the call: a recap, generated now, for whoever switched it on. */
  brainRecap(id: string): Promise<string>
}

export function brainClient(): BrainClient {
  return {
    setBrain: (id, on) => call(`${at(id)}/brain`, { method: 'POST', body: JSON.stringify({ on }) }),
    askBrain: async (id, question) =>
      (
        await request<{ answer: BrainAnswerDto }>(`${at(id)}/brain/ask`, {
          method: 'POST',
          body: JSON.stringify({ question }),
        })
      ).answer,
    myBrainAnswers: async (id) =>
      (await request<{ answers: BrainAnswerDto[] }>(`${at(id)}/brain`)).answers,
    shareBrainAnswer: (id, answerId) =>
      call(`${at(id)}/brain/answers/${encodeURIComponent(answerId)}/share`, { method: 'POST' }),
    brainRecap: async (id) =>
      (await request<{ recap: string }>(`${at(id)}/brain/recap`, { method: 'POST' })).recap,
  }
}

/** The call's chat, a member's or a guest's side (the same two calls). */
export type ChatClient = {
  /** The chat in order after `since` (a seq; 0 = from the start). */
  readChat(id: string, since: number): Promise<CallChatPage>
  /** Write a line; the stored line comes back. */
  postChat(id: string, body: string): Promise<CallChatMessageDto>
}

/** A member's chat: /api/calls/[id]/chat (the calls.chat_read / calls.chat_post tools' route). */
export function chatClient(): ChatClient {
  return {
    readChat: (id, since) => request<CallChatPage>(`${at(id)}/chat?since=${since}`),
    postChat: async (id, body) =>
      (
        await request<{ message: CallChatMessageDto }>(`${at(id)}/chat`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        })
      ).message,
  }
}

/** A guest's chat: their link is the proof (the call id is the link's call). */
export function guestChatClient(linkToken: string): ChatClient {
  const base = `/api/calls/guest/${encodeURIComponent(linkToken)}/chat`
  return {
    readChat: (_id, since) => request<CallChatPage>(`${base}?since=${since}`),
    postChat: async (_id, body) =>
      (
        await request<{ message: CallChatMessageDto }>(base, {
          method: 'POST',
          body: JSON.stringify({ body }),
        })
      ).message,
  }
}

/** The calls the live call (ActiveCall + CallTranscription) needs; a member's or a guest's. */
export type LiveCallClient = Pick<
  CallsClient,
  'accept' | 'token' | 'hangup' | 'get' | 'transcribe' | 'setTranscription'
>

/** A chunk goes as its raw audio (exempt from the CSRF origin check, like dictation) with its length in a header. */
const chunkInit = (chunk: Blob, durationMs: number): RequestInit => ({
  method: 'POST',
  body: chunk,
  headers: {
    'content-type': chunk.type || 'application/octet-stream',
    'x-chunk-duration-ms': String(Math.round(durationMs)),
  },
})

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
  } catch (err) {
    throw new CallRequestError({
      kind: 'failed',
      message: `could not reach the server (${err instanceof Error ? err.message : String(err)})`,
      agent: null,
    })
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new CallRequestError(problemFromResponse(res.status, body))
  return body as T
}

const at = (id: string) => `/api/calls/${encodeURIComponent(id)}`

const call = async (path: string, init?: RequestInit) =>
  (await request<{ call: CallDto }>(path, init)).call

export function callsClient(): CallsClient {
  return {
    start: (input) => call('/api/calls', { method: 'POST', body: JSON.stringify(input) }),
    get: (id) => call(at(id)),
    accept: (id) => call(`${at(id)}/accept`, { method: 'POST' }),
    decline: (id) => call(`${at(id)}/decline`, { method: 'POST' }),
    hangup: (id, opts) =>
      call(`${at(id)}/hangup`, { method: 'POST', keepalive: opts?.keepalive === true }),
    token: (id) => request<CallTokenDto>(`${at(id)}/token`),
    schedule: (input) =>
      request<ScheduleResult>('/api/calls/meetings', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    inviteGuests: (id, guests, timeZone) =>
      request<ScheduleResult>(`${at(id)}/guests`, {
        method: 'POST',
        body: JSON.stringify({ guests, timeZone }),
      }),
    revokeGuest: (id, guestId) =>
      call(`${at(id)}/guests/${encodeURIComponent(guestId)}`, { method: 'DELETE' }),
    transcribe: async (id, chunk, durationMs) =>
      (
        await request<{ segment: TranscriptSegmentDto | null }>(
          `${at(id)}/transcript`,
          chunkInit(chunk, durationMs),
        )
      ).segment,
    setTranscription: (id, on) =>
      call(`${at(id)}/transcription`, { method: 'POST', body: JSON.stringify({ on }) }),
  }
}

/**
 * A guest's side (the public /join/[token] page): the same calls the
 * call view needs, answered by the guest routes. "Accept" is the join with
 * the name the guest typed; the room token comes from that same join.
 */
export function guestCallsClient(linkToken: string, name: () => string): LiveCallClient {
  const base = `/api/calls/guest/${encodeURIComponent(linkToken)}`
  let joined: GuestJoinDto | null = null
  const join = async () =>
    (joined = await request<GuestJoinDto>(`${base}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: name() }),
    }))
  return {
    accept: async () => (await join()).call,
    // Every (re)join asks for a fresh token: the last one may be used up or close to expiry.
    token: async () => {
      const t = joined?.token ?? (await join()).token
      joined = null
      return t
    },
    hangup: (_id, opts) =>
      call(`${base}/leave`, { method: 'POST', keepalive: opts?.keepalive === true }),
    get: () => call(base),
    transcribe: async (_id, chunk, durationMs) =>
      (
        await request<{ segment: TranscriptSegmentDto | null }>(
          `${base}/transcript`,
          chunkInit(chunk, durationMs),
        )
      ).segment,
    setTranscription: (_id, on) =>
      call(`${base}/transcription`, { method: 'POST', body: JSON.stringify({ on }) }),
  }
}

/** The error a person reads for any refused calls request. */
export const problemOf = (err: unknown): CallProblem =>
  err instanceof CallRequestError
    ? err.problem
    : { kind: 'failed', message: err instanceof Error ? err.message : String(err), agent: null }

/** A refused calls request as a page shows it: the sentence (optionally prefixed) and the server's agent report. */
export const shownProblemOf = (err: unknown, prefix = ''): ShownError => {
  const p = problemOf(err)
  return { error: `${prefix}${p.message}`, agent: p.agent }
}
