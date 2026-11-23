import type { CallChatMessageDto, CallDto, CallsService } from './service'

/**
 * Real-time call frames for GET /api/calls/stream (its own stream, so a call
 * rings on any nucleus page without Messages). Every stored change wakes the
 * hub in EVERY app process (pg_notify('ee_calls', <call id>), both blue-green
 * slots); it loads the call once and sends a frame to each connected person
 * who is part of it — membership re-checked per person at send time. Frames
 * carry the whole call, so a (re)connecting client needs no event log: the
 * stream opens with a snapshot of the person's ringing/active calls.
 *
 *   call.ringing — the call is ringing for THIS person (show the toast)
 *   call.state   — anything else about a call they are part of
 *   call.chat    — a new line in the chat of a call they may read it in
 *                  (pg_notify('ee_calls_chat', <seq>) → dispatchChat)
 *
 * Chat frames are not replayed: a client that (re)connects reads the chat on
 * from its own cursor (GET /api/calls/[id]/chat?since=…).
 */

export type CallFrame = { event: 'call.ringing' | 'call.state'; data: { call: CallDto } }
export type ChatFrame = { event: 'call.chat'; data: { callId: string; message: CallChatMessageDto } }

type Subscriber = { userId: string; send: (f: CallFrame) => void; sendChat: (f: ChatFrame) => void }

export class CallsHub {
  private readonly subscribers = new Set<Subscriber>()

  constructor(private readonly service: Pick<CallsService, 'load' | 'viewFor' | 'liveViews' | 'chatMessage' | 'canReadChat'>) {}

  get size(): number {
    return this.subscribers.size
  }

  subscribe(userId: string, send: (f: CallFrame) => void, sendChat: (f: ChatFrame) => void = () => {}): () => void {
    const sub = { userId, send, sendChat }
    this.subscribers.add(sub)
    return () => this.subscribers.delete(sub)
  }

  async dispatch(callId: string): Promise<void> {
    if (this.subscribers.size === 0) return
    const rec = await this.service.load(callId)
    if (!rec) throw new Error(`call ${callId} not found`)
    for (const sub of [...this.subscribers]) {
      try {
        const view = await this.service.viewFor(sub.userId, rec)
        if (view) sub.send({ event: view.ringing ? 'call.ringing' : 'call.state', data: { call: view.call } })
      } catch (err) {
        console.error('[calls] building a stream frame failed', { callId, userId: sub.userId, err })
      }
    }
  }

  /** A new chat line (by its seq): to each connected person who may read that call's chat — re-checked per person now. */
  async dispatchChat(seq: number): Promise<void> {
    if (this.subscribers.size === 0) return
    const line = await this.service.chatMessage(seq)
    if (!line) throw new Error(`call chat line ${seq} not found`)
    const rec = await this.service.load(line.callId)
    if (!rec) throw new Error(`call ${line.callId} not found`)
    for (const sub of [...this.subscribers]) {
      try {
        if (await this.service.canReadChat(sub.userId, rec)) sub.sendChat({ event: 'call.chat', data: line })
      } catch (err) {
        console.error('[calls] building a chat frame failed', { callId: line.callId, seq, userId: sub.userId, err })
      }
    }
  }

  /** After the LISTEN connection came back: changes meanwhile were not heard — resend every subscriber its live calls. */
  async resync(): Promise<void> {
    for (const sub of [...this.subscribers]) {
      try {
        for (const f of await this.snapshot(sub.userId)) sub.send(f)
      } catch (err) {
        console.error('[calls] resync after LISTEN reconnect failed', { userId: sub.userId, err })
      }
    }
  }

  /** The person's live calls, as frames (sent first on every connect). */
  async snapshot(userId: string): Promise<CallFrame[]> {
    return (await this.service.liveViews(userId)).map((v) => ({
      event: v.ringing ? 'call.ringing' : 'call.state',
      data: { call: v.call },
    }))
  }
}

const HEARTBEAT_MS = 25_000

export function encodeCallFrame(f: CallFrame | ChatFrame): string {
  return `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`
}

/**
 * One person's SSE response: subscribe first (buffering), send the snapshot,
 * then the buffered and live frames. Frames are whole-call states, so a
 * duplicate between snapshot and buffer is harmless.
 */
export function callsStreamResponse(hub: CallsHub, userId: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  let closed = false
  let unsubscribe = () => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const close = () => {
    if (closed) return
    closed = true
    unsubscribe()
    if (heartbeat) clearInterval(heartbeat)
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text))
      }
      let buffer: (CallFrame | ChatFrame)[] | null = []
      const send = (f: CallFrame | ChatFrame) => (buffer ? buffer.push(f) : write(encodeCallFrame(f)))
      unsubscribe = hub.subscribe(userId, send, send)
      if (signal.aborted) return close()
      signal.addEventListener('abort', close, { once: true })
      write(': connected\n\n')
      try {
        for (const f of await hub.snapshot(userId)) write(encodeCallFrame(f))
      } catch (err) {
        console.error('[calls] stream snapshot failed', { userId, err })
        write(`event: error\ndata: ${JSON.stringify({ error: 'could not load your calls; reload' })}\n\n`)
      }
      const pending = buffer
      buffer = null
      for (const f of pending) write(encodeCallFrame(f))
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
