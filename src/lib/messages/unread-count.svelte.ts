import { ResumableStream, type StreamSource } from './resumable-stream'

/**
 * The unread counter on the sidebar's Messages entry (wish f397009a): the
 * person's unread count per conversation, seeded by the layout load at an
 * event id and kept current by the messages stream from that id on (every
 * frame carries the conversation's fresh count, so nothing is recounted here).
 */
export type UnreadSeed = { cursor: number; byConversation: Record<string, number> }

export const unreadTotal = (m: Readonly<Record<string, number>>) => Object.values(m).reduce((s, n) => s + n, 0)

/** The counts after one stream frame (unchanged — the same object — for frames that carry none). */
export function applyUnreadFrame(m: Record<string, number>, type: string, payload: unknown): Record<string, number> {
  if (type === 'message') {
    const f = payload as { message: { conversationId: string }; unread: number }
    return { ...m, [f.message.conversationId]: f.unread }
  }
  if (type === 'read') {
    const f = payload as { conversationId: string; unread: number }
    return { ...m, [f.conversationId]: f.unread }
  }
  if (type === 'conversation') {
    const f = payload as { conversation: { id: string; unread: number } }
    return { ...m, [f.conversation.id]: f.conversation.unread }
  }
  return m
}

export class MessagesUnread {
  #counts = $state<Record<string, number>>({})
  #stream: ResumableStream | null = null

  constructor(private readonly seed: UnreadSeed) {
    this.#counts = { ...seed.byConversation }
  }

  get total(): number {
    return unreadTotal(this.#counts)
  }

  connect(create?: (url: string) => StreamSource): void {
    this.#stream = new ResumableStream({
      url: (after) => `/api/messages/stream?after=${after}`,
      initialCursor: this.seed.cursor,
      events: ['message', 'conversation', 'read'],
      onStatus: () => {},
      onEvent: (type, payload) => {
        this.#counts = applyUnreadFrame(this.#counts, type, payload)
      },
      ...(create ? { create } : {}),
    })
    this.#stream.connect()
  }

  resume(): void {
    this.#stream?.resume()
  }

  close(): void {
    this.#stream?.close()
  }
}
