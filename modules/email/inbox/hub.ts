import type { InboxDeps } from './service'
import { z } from 'zod'
import { canReadMailbox } from './service'

/**
 * Live mail for /api/mail/inbox/stream (S4). Every stored or changed mail
 * fires pg_notify('inbox_messages', <mailbox id>); the hub in each app
 * process forwards the mailbox id — nothing else — to every connected person
 * who reads that mailbox at that moment (access checked per event, per
 * person). The page then re-fetches its own data through the normal load.
 * There is no event log to catch up from: a reconnecting page simply reloads.
 */

type Subscriber = { userId: string; send: (mailboxId: string) => void }

const mailboxId = z.string().uuid()

/** The NOTIFY payload is a mailbox id; anything else is ignored (and logged by the caller). */
export function parseNotifyPayload(payload: string): string | null {
  const r = mailboxId.safeParse(payload)
  return r.success ? r.data : null
}

export class InboxHub {
  private readonly subscribers = new Set<Subscriber>()

  constructor(private readonly deps: InboxDeps) {}

  get size(): number {
    return this.subscribers.size
  }

  subscribe(userId: string, send: (mailboxId: string) => void): () => void {
    const sub = { userId, send }
    this.subscribers.add(sub)
    return () => this.subscribers.delete(sub)
  }

  async dispatch(mailboxId: string): Promise<void> {
    for (const sub of [...this.subscribers]) {
      try {
        if (await canReadMailbox(this.deps, sub.userId, mailboxId)) sub.send(mailboxId)
      } catch (err) {
        console.error('[inbox] checking a stream subscriber failed', { mailboxId, userId: sub.userId, err })
      }
    }
  }
}

const HEARTBEAT_MS = 25_000

/** One person's SSE response: `event: mailbox` frames with `{ mailboxId }`, a keepalive comment every 25 s. */
export function inboxStreamResponse(hub: InboxHub, userId: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  let closed = false
  let unsubscribe = () => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let end = () => {}
  const close = () => {
    if (closed) return
    closed = true
    unsubscribe()
    if (heartbeat) clearInterval(heartbeat)
    end()
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      end = () => {
        try {
          controller.close()
        } catch {
          // Already closed by the reader cancelling.
        }
      }
      const write = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text))
      }
      unsubscribe = hub.subscribe(userId, (id) => write(`event: mailbox\ndata: ${JSON.stringify({ mailboxId: id })}\n\n`))
      if (signal.aborted) return close()
      signal.addEventListener('abort', close, { once: true })
      write(': connected\n\n')
      heartbeat = setInterval(() => write(': keepalive\n\n'), HEARTBEAT_MS)
    },
    cancel() {
      close()
    },
  })
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
  })
}
