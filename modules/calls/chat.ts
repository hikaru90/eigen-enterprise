import type { TranscriptTurn } from './transcript'
import { CallsError } from './errors'

/**
 * Chat in a call (proposal bb05b451): the people in a call — members and
 * guests invited by link — write text to each other while it goes on. One
 * Calls table for every call (DM, channel, meeting): a guest has no account,
 * and Messages' authors are accounts. The lines stay after the call; the
 * transcript page shows them with what was said, and the Company Brain reads
 * the ones written while it listened, marked as chat (brain.ts heardChat).
 *
 * `seq` is arrival order: a live reader (the member's stream, a guest's
 * refresh) keeps the highest seq it has and asks for what came after.
 * Times are the server's (`createdAt`, set by the service's clock).
 *
 * Table: call_chat_message (drizzle/0169_call_chat.sql).
 */

export type ChatAuthorKind = 'member' | 'guest'

export type ChatMessage = {
  /** Arrival order (bigserial): a live reader's cursor. */
  seq: number
  callId: string
  /** The participant id: a user id, or guest:<id> (guestIdentity). */
  authorId: string
  authorKind: ChatAuthorKind
  /** Their name when they wrote it. */
  authorName: string
  body: string
  createdAt: Date
}

export type NewChatMessage = Omit<ChatMessage, 'seq'>

export type CallChatStore = {
  /** Stores the line (and wakes every listening process); its seq is assigned here. */
  add(message: NewChatMessage): Promise<ChatMessage>
  /** The call's lines in arrival order; with `since`, only seq > since; at most `limit`. */
  list(callId: string, since?: number, limit?: number): Promise<ChatMessage[]>
  /** One line by its seq (the live stream's wake-up names only the seq). */
  get(seq: number): Promise<ChatMessage | null>
  /** Lines per call; calls without any are absent. */
  countByCall(callIds: string[]): Promise<Map<string, number>>
}

/** The longest line (the column's check). */
export const MAX_CHAT_BODY = 4000
/** How many lines one read returns at most (the reader pages on with its cursor). */
export const CHAT_PAGE = 200

/** A typed line: trimmed, 1–MAX_CHAT_BODY characters. */
export function parseChatBody(raw: unknown): string {
  if (typeof raw !== 'string') throw new CallsError('invalid', 'a chat message is text')
  const body = raw.trim()
  if (body === '') throw new CallsError('invalid', 'write something first')
  if (body.length > MAX_CHAT_BODY) throw new CallsError('invalid', `a chat message is at most ${MAX_CHAT_BODY} characters`)
  return body
}

/** Each chat line as one turn of the call (never joined with what someone said). */
export function chatTurns(messages: readonly ChatMessage[]): TranscriptTurn[] {
  return [...messages]
    .sort((a, b) => a.seq - b.seq)
    .map((m) => ({
      speakerId: m.authorId,
      speakerKind: m.authorKind,
      speakerName: m.authorName,
      startedAt: new Date(m.createdAt),
      endedAt: new Date(m.createdAt),
      text: m.body,
      source: 'chat' as const,
    }))
}

/** The store for specs: the Postgres store's semantics (seq in arrival order, checks). */
export class MemoryChatStore implements CallChatStore {
  readonly messages: ChatMessage[] = []
  /** The live wiring's NOTIFY, faked: told each new line's seq after it is stored. */
  onAdd: ((seq: number) => void) | null = null
  #seq = 0

  async add(message: NewChatMessage): Promise<ChatMessage> {
    if (message.body.length === 0 || message.body.length > MAX_CHAT_BODY) throw new Error('calls: a chat message needs 1–4000 characters')
    if (message.authorName.length === 0 || message.authorName.length > 200) throw new Error('calls: a chat author needs a name of 1–200 characters')
    const stored: ChatMessage = { ...message, seq: ++this.#seq, createdAt: new Date(message.createdAt) }
    this.messages.push(stored)
    this.onAdd?.(stored.seq)
    return structuredClone(stored)
  }

  async list(callId: string, since?: number, limit?: number): Promise<ChatMessage[]> {
    const out = this.messages.filter((m) => m.callId === callId && (since === undefined || m.seq > since))
    return structuredClone(limit === undefined ? out : out.slice(0, limit))
  }

  async get(seq: number): Promise<ChatMessage | null> {
    const m = this.messages.find((x) => x.seq === seq)
    return m ? structuredClone(m) : null
  }

  async countByCall(callIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    for (const m of this.messages) if (callIds.includes(m.callId)) counts.set(m.callId, (counts.get(m.callId) ?? 0) + 1)
    return counts
  }
}
