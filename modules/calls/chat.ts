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
  /** A pasted image (wish 4fbf9991); the body is then empty. */
  imageId: string | null
  createdAt: Date
}

export type NewChatMessage = Omit<ChatMessage, 'seq' | 'imageId'> & { imageId?: string | null }

/** A pasted image's bytes, kept with the call (a guest has no Drive). */
export type ChatImage = {
  id: string
  callId: string
  uploadedBy: string
  name: string
  mime: string
  size: number
  bytes: Uint8Array
  createdAt: Date
}
export type ChatImageInfo = Omit<ChatImage, 'bytes' | 'uploadedBy' | 'createdAt' | 'callId'>

export type CallChatStore = {
  /** Stores the line (and wakes every listening process); its seq is assigned here. */
  add(message: NewChatMessage): Promise<ChatMessage>
  /** The call's lines in arrival order; with `since`, only seq > since; at most `limit`. */
  list(callId: string, since?: number, limit?: number): Promise<ChatMessage[]>
  /** One line by its seq (the live stream's wake-up names only the seq). */
  get(seq: number): Promise<ChatMessage | null>
  /** Lines per call; calls without any are absent. */
  countByCall(callIds: string[]): Promise<Map<string, number>>
  /** Stores a pasted image's bytes (its line is added after, with add()). */
  addImage(image: ChatImage): Promise<void>
  /** One image of this call (null: none such in this call). */
  image(callId: string, id: string): Promise<ChatImage | null>
  /** Name, type and size of these images (the lines' display). */
  imageInfo(ids: string[]): Promise<Map<string, ChatImageInfo>>
}

/** The largest pasted image (the column's check). */
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024

/** Raster images the browser shows inline (SVG never: active content) — Messages' rule (isInlineImage). */
const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif)$/i

export type ChatImageUpload = { name: string; mime: string; bytes: Uint8Array }

/** A pasted image: a raster type, 1 byte – MAX_CHAT_IMAGE_BYTES, a name (defaulted for a clipboard image). */
export function parseChatImage(raw: ChatImageUpload): ChatImageUpload {
  if (!INLINE_IMAGE.test(raw.mime))
    throw new CallsError(
      'invalid',
      'only images (PNG, JPEG, GIF, WebP, AVIF) can be pasted in the chat',
    )
  if (raw.bytes.byteLength === 0) throw new CallsError('invalid', 'the image is empty')
  if (raw.bytes.byteLength > MAX_CHAT_IMAGE_BYTES)
    throw new CallsError(
      'invalid',
      `an image in the chat is at most ${MAX_CHAT_IMAGE_BYTES / 1024 / 1024} MB`,
    )
  const name = raw.name.trim().slice(0, 200) || 'image'
  return { name, mime: raw.mime.toLowerCase(), bytes: raw.bytes }
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
  // An image line has no text: nothing of it is read as a turn.
  return [...messages]
    .filter((m) => m.body !== '')
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

  readonly images: ChatImage[] = []

  async addImage(image: ChatImage): Promise<void> {
    this.images.push(structuredClone(image))
  }

  async image(callId: string, id: string): Promise<ChatImage | null> {
    const i = this.images.find((x) => x.id === id && x.callId === callId)
    return i ? structuredClone(i) : null
  }

  async imageInfo(ids: string[]): Promise<Map<string, ChatImageInfo>> {
    return new Map(
      this.images
        .filter((i) => ids.includes(i.id))
        .map((i) => [i.id, { id: i.id, name: i.name, mime: i.mime, size: i.size }]),
    )
  }

  async add(message: NewChatMessage): Promise<ChatMessage> {
    const imageId = message.imageId ?? null
    if ((message.body.length === 0 && imageId === null) || message.body.length > MAX_CHAT_BODY)
      throw new Error('calls: a chat message needs 1–4000 characters')
    if (message.authorName.length === 0 || message.authorName.length > 200)
      throw new Error('calls: a chat author needs a name of 1–200 characters')
    const stored: ChatMessage = {
      ...message,
      imageId,
      seq: ++this.#seq,
      createdAt: new Date(message.createdAt),
    }
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
