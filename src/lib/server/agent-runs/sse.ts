import type { AgentEvent, AgentEventStream, SnapshotEvent } from '$lib/server/agent/pi-durable'
import { projectEvents, projectSnapshot } from './project'

/** Comment frames keep idle connections alive through the edge proxy. */
const HEARTBEAT_MS = 25_000

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Fans one pi-durable event stream out as Server-Sent Events (D8): a
 * `snapshot` frame on connect, then one `batch` frame per commit (an overflow
 * snapshot from pi-durable becomes a fresh `snapshot` frame), and an `end`
 * frame if the watch closes on its own. The watcher is stopped exactly once,
 * when the client goes away (stream cancel or request abort).
 */
export function runEventsResponse(stream: AgentEventStream, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  let finished = false
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const finish = (): boolean => {
    if (finished) return false
    finished = true
    if (heartbeat) clearInterval(heartbeat)
    return true
  }
  const disconnect = () => {
    if (!finish()) return
    stream.stop().catch((err: unknown) => {
      console.error('[agent-runs] stopping the event watcher failed:', err)
    })
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        if (!finished) controller.enqueue(encoder.encode(text))
      }
      send(frame('snapshot', projectSnapshot(stream.snapshot)))

      stream.start(async (events: readonly AgentEvent[]) => {
        let pending: AgentEvent[] = []
        const flush = () => {
          const items = projectEvents(pending)
          pending = []
          if (items.length > 0) send(frame('batch', { items }))
        }
        for (const event of events) {
          if (event.type === 'snapshot') {
            flush()
            send(frame('snapshot', projectSnapshot(event as SnapshotEvent)))
          } else {
            pending.push(event)
          }
        }
        flush()
      })

      void stream.closed.then(() => {
        if (!finish()) return
        controller.enqueue(encoder.encode(frame('end', {})))
        controller.close()
      })

      heartbeat = setInterval(() => send(': keepalive\n\n'), HEARTBEAT_MS)
      if (signal.aborted) disconnect()
      else signal.addEventListener('abort', disconnect, { once: true })
    },
    cancel() {
      disconnect()
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
