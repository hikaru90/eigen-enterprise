import type { Actor, SheetLive } from './service'
import type { RequestEvent } from '@sveltejs/kit'
import { z } from 'zod'
import type { StreamEvent } from '$lib/office/xlsx/collab/protocol'
import { MAX_BATCH } from '$lib/office/xlsx/collab/protocol'
import { SHEET_OP_NAMES } from '$lib/office/xlsx/collab/transform'
import { DriveError, driveJson } from '$lib/server/drive'

const idSchema = z.string().min(1).max(120)

const wireImageSchema = z.union([
  z.object({ exists: z.literal(false) }).strict(),
  z.object({ exists: z.literal(true), contentType: z.string().min(1).max(200), data: z.string() }).strict(),
])

const changeBodySchema = z
  .object({
    kind: z.literal('change'),
    ops: z.array(z.looseObject({ op: z.enum(SHEET_OP_NAMES) })).min(1).max(MAX_BATCH),
    acceptLosses: z.boolean(),
  })
  .strict()

const revertBodySchema = z
  .object({
    kind: z.literal('revert'),
    of: idSchema,
    images: z.record(z.string(), wireImageSchema),
  })
  .strict()

export const submitSchema = z
  .object({
    clientId: idSchema,
    baseSeq: z.number().int().min(0),
    changes: z
      .array(
        z
          .object({
            opId: idSchema,
            body: z.discriminatedUnion('kind', [changeBodySchema, revertBodySchema]),
          })
          .strict(),
      )
      .max(MAX_BATCH),
  })
  .strict()

export const presenceSchema = z
  .object({
    clientId: idSchema,
    sheet: z.string().min(1).max(200).nullable(),
    range: z.string().min(1).max(100).nullable(),
  })
  .strict()

export function parseAfter(raw: string | null): number {
  if (raw === null || raw === '') return 0
  if (!/^\d+$/.test(raw)) throw new DriveError('invalid', 'after: must be a non-negative integer.')
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 0) throw new DriveError('invalid', 'after: must be a non-negative integer.')
  return n
}

const STREAM_HEARTBEAT_MS = 25_000

function encodeFrame(e: StreamEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`
}

/**
 * Opens an SSE stream for one live workbook tab. Buffers initial events
 * while `connect()` checks Drive access and replays initial state so
 * errors return JSON 401/403/404/400 before SSE headers are committed.
 */
export async function sheetLiveStreamResponse(
  event: Pick<RequestEvent, 'request' | 'url'>,
  live: SheetLive,
  actor: Actor,
  fileId: string,
): Promise<Response> {
  try {
    const rawClient = event.url.searchParams.get('clientId')
    const parsedClient = idSchema.safeParse(rawClient)
    if (!parsedClient.success) throw new DriveError('invalid', 'clientId: 1–120 characters required.')
    const after = parseAfter(event.url.searchParams.get('after'))
    const clientId = parsedClient.data

    let buffer: StreamEvent[] | null = []
    let emit: ((frame: string) => void) | null = null
    const send = (e: StreamEvent) => {
      if (emit) emit(encodeFrame(e))
      else if (buffer) buffer.push(e)
    }

    const disconnect = await live.connect(actor, fileId, clientId, after, send)
    const encoder = new TextEncoder()
    let closed = false
    let heartbeat: ReturnType<typeof setInterval> | undefined

    const close = () => {
      if (closed) return
      closed = true
      emit = null
      buffer = null
      if (heartbeat) clearInterval(heartbeat)
      void disconnect().catch((err) => console.error('[sheet-live] disconnect failed', { fileId, clientId, err }))
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(text))
          } catch {
            close()
          }
        }
        emit = write
        if (event.request.signal.aborted) {
          close()
          try {
            controller.close()
          } catch {
            // Already closed by the client going away: nothing left to end.
          }
          return
        }
        event.request.signal.addEventListener('abort', close, { once: true })
        write(': connected\n\n')
        const queued = buffer ?? []
        buffer = null
        for (const e of queued) write(encodeFrame(e))
        heartbeat = setInterval(() => write(': keepalive\n\n'), STREAM_HEARTBEAT_MS)
        ;(heartbeat as { unref?: () => void } | undefined)?.unref?.()
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
  } catch (err) {
    if (err instanceof DriveError) {
      return driveJson(event, () => Promise.reject(err))
    }
    throw err
  }
}
