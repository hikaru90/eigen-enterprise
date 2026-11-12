import type { PresenceFrame, PresenceStream } from './presence'
import type { MessageEvent } from './store'
import {
  canUse,
  messageDtos,
  summarize,
  unreadFor,
  type ConversationSummary,
  type MessageDto,
  type MessagesDeps,
} from './service'

/**
 * Real-time fan-out for /api/messages/stream. Every change is a row in
 * message_events; pg_notify('ee_messages', id) wakes the hub in EVERY app
 * process (both blue-green slots), which loads the event once and sends a
 * frame to each connected person who may see that conversation — access is
 * checked per event, per person, at send time. A reconnecting client sends
 * Last-Event-ID and is caught up from the table before live frames resume.
 */

export type StreamFrame =
  | {
      id: number
      event: 'message'
      data: {
        action: 'created' | 'edited' | 'deleted' | 'reacted'
        message: MessageDto
        /** Replies: the thread's first message with its fresh reply count. */
        parent: MessageDto | null
        unread: number
      }
    }
  | { id: number; event: 'conversation'; data: { conversation: ConversationSummary } }
  | { id: number; event: 'read'; data: { conversationId: string; unread: number } }

const ACTIONS = {
  'message.created': 'created',
  'message.edited': 'edited',
  'message.deleted': 'deleted',
  'message.reacted': 'reacted',
} as const satisfies Partial<Record<MessageEvent['kind'], string>>

type Subscriber = { userId: string; send: (f: StreamFrame) => void }

export const CATCH_UP_LIMIT = 500

export class MessagesHub {
  private readonly subscribers = new Set<Subscriber>()
  /** Highest event id this process has dispatched (resync after a listener reconnect). */
  lastDispatchedId = 0

  constructor(private readonly deps: MessagesDeps) {}

  get size(): number {
    return this.subscribers.size
  }

  subscribe(userId: string, send: (f: StreamFrame) => void): () => void {
    const sub = { userId, send }
    this.subscribers.add(sub)
    return () => this.subscribers.delete(sub)
  }

  /** The frame `userId` gets for this event, or null when it is not theirs to see. */
  async frameFor(event: MessageEvent, userId: string): Promise<StreamFrame | null> {
    const d = this.deps
    const c = await d.store.getConversation(event.conversationId)
    if (!c || !(await canUse(d, userId, c))) return null
    if (event.kind === 'conversation.read') {
      if (event.userId !== userId) return null
      return { id: event.id, event: 'read', data: { conversationId: c.id, unread: await unreadFor(d, userId, c.id) } }
    }
    if (event.kind === 'conversation.created') {
      return { id: event.id, event: 'conversation', data: { conversation: await summarize(d, userId, c) } }
    }
    if (!event.messageId || !(event.kind in ACTIONS)) return null
    const m = await d.store.getMessage(event.messageId)
    if (!m) return null
    const people = new Map((await d.directory.listPeople()).map((p) => [p.id, p]))
    const parentRow = m.parentId ? await d.store.getMessage(m.parentId) : null
    const [message, parent] = await messageDtos(d, parentRow ? [m, parentRow] : [m], people)
    return {
      id: event.id,
      event: 'message',
      data: { action: ACTIONS[event.kind as keyof typeof ACTIONS], message, parent: parent ?? null, unread: await unreadFor(d, userId, c.id) },
    }
  }

  async dispatch(eventId: number): Promise<void> {
    const event = await this.deps.store.getEvent(eventId)
    if (!event) throw new Error(`message event ${eventId} not found`)
    this.lastDispatchedId = Math.max(this.lastDispatchedId, eventId)
    for (const sub of [...this.subscribers]) {
      try {
        const frame = await this.frameFor(event, sub.userId)
        if (frame) sub.send(frame)
      } catch (err) {
        console.error('[messages] building a stream frame failed', { eventId, userId: sub.userId, err })
      }
    }
  }

  /** After the LISTEN connection came back: dispatch whatever was committed meanwhile. */
  async resync(): Promise<void> {
    if (this.lastDispatchedId === 0) return
    for (const e of await this.deps.store.eventsAfter(this.lastDispatchedId, CATCH_UP_LIMIT)) await this.dispatch(e.id)
  }

  /** Frames after `afterId` this person may see (Last-Event-ID catch-up). */
  async catchUp(userId: string, afterId: number): Promise<StreamFrame[]> {
    const out: StreamFrame[] = []
    for (const e of await this.deps.store.eventsAfter(afterId, CATCH_UP_LIMIT)) {
      const frame = await this.frameFor(e, userId)
      if (frame) out.push(frame)
    }
    return out
  }
}

const HEARTBEAT_MS = 25_000

export function encodeFrame(f: StreamFrame): string {
  return `id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`
}

/** Presence is not in the event log: no `id:` line, so the browser's Last-Event-ID stays the last message event's. */
export function encodePresenceFrame(f: PresenceFrame): string {
  return `event: presence\ndata: ${JSON.stringify(f)}\n\n`
}

/**
 * One person's SSE response. Subscribes first and buffers, then sends the
 * catch-up after `lastEventId`, then the buffered and live frames — each
 * event id at most once. `presence` (null: the person is not in the company)
 * adds the company's presence: a full snapshot on every (re)connect, then
 * changes as they happen.
 */
export function messagesStreamResponse(
  hub: MessagesHub,
  userId: string,
  lastEventId: number | null,
  signal: AbortSignal,
  presence: PresenceStream | null,
): Response {
  const encoder = new TextEncoder()
  let closed = false
  let unsubscribe = () => {}
  let stopPresence = () => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const sent = new Set<number>()
  const close = () => {
    if (closed) return
    closed = true
    unsubscribe()
    stopPresence()
    if (heartbeat) clearInterval(heartbeat)
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text))
      }
      const emit = (f: StreamFrame) => {
        if (sent.has(f.id)) return
        sent.add(f.id)
        write(encodeFrame(f))
      }
      let buffer: StreamFrame[] | null = []
      unsubscribe = hub.subscribe(userId, (f) => (buffer ? buffer.push(f) : emit(f)))
      if (signal.aborted) return close()
      signal.addEventListener('abort', close, { once: true })
      write(': connected\n\n')
      if (presence) {
        try {
          const stop = await presence.start((f) => write(encodePresenceFrame(f)))
          if (closed) stop()
          else stopPresence = stop
        } catch (err) {
          console.error('[messages] stream presence failed', { userId, err })
          write(`event: presence-error\ndata: ${JSON.stringify({ error: 'Status is unavailable right now; reload to try again.' })}\n\n`)
        }
      }
      try {
        if (lastEventId !== null) for (const f of await hub.catchUp(userId, lastEventId)) emit(f)
      } catch (err) {
        console.error('[messages] stream catch-up failed', { userId, lastEventId, err })
        write(`event: error\ndata: ${JSON.stringify({ error: 'catch-up failed; reload' })}\n\n`)
      }
      const pending: StreamFrame[] = buffer
      buffer = null
      for (const f of pending) emit(f)
      heartbeat = setInterval(() => write(': keepalive\n\n'), HEARTBEAT_MS)
    },
    cancel() {
      close()
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}

export function parseLastEventId(header: string | null): number | null {
  if (header === null || header.trim() === '') return null
  const n = Number(header)
  if (!Number.isSafeInteger(n) || n < 0) return null
  return n
}
