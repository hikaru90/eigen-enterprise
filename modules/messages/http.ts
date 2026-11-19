import { json } from '@sveltejs/kit'
import { MessagesError, type MessagesDeps, type VoiceClipInput } from './service'

/**
 * Shared plumbing for /api/messages/*: signed-in only, the live deps, and
 * MessagesError → HTTP status (not_found 404, forbidden 403, invalid 400,
 * conflict 409). Anything else is a 500 with its message, logged.
 */

const STATUS: Record<MessagesError['code'], number> = { not_found: 404, forbidden: 403, invalid: 400, conflict: 409 }

export async function messagesRoute(
  user: { id: string } | null | undefined,
  run: (userId: string, deps: MessagesDeps) => Promise<unknown>,
): Promise<Response> {
  if (!user) return json({ error: 'sign in first' }, { status: 401 })
  try {
    const { messagesDeps } = await import('./live')
    const out = await run(user.id, await messagesDeps())
    return out instanceof Response ? out : json(out ?? { ok: true })
  } catch (err) {
    if (err instanceof MessagesError) return json({ error: err.message, code: err.code }, { status: STATUS[err.code] })
    console.error('[messages] request failed', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new MessagesError('invalid', 'expected a JSON object body')
}

export function stringList(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new MessagesError('invalid', `${field} must be a list of ids`)
  }
  return v as string[]
}

/** `voiceClips`: [{ fileId, durationMs }] (the service judges the values). */
export function voiceClipList(v: unknown): VoiceClipInput[] {
  if (v === undefined || v === null) return []
  const ok =
    Array.isArray(v) &&
    v.every((x: unknown) => {
      if (!x || typeof x !== 'object') return false
      const { fileId, durationMs } = x as Record<string, unknown>
      return typeof fileId === 'string' && typeof durationMs === 'number'
    })
  if (!ok) throw new MessagesError('invalid', 'voiceClips must be a list of { fileId, durationMs }')
  return (v as VoiceClipInput[]).map(({ fileId, durationMs }) => ({ fileId, durationMs }))
}

/**
 * Serves bytes with single-range support (`Range: bytes=a-b`, `a-`, `-n`): audio players
 * seek and stream by range. A range outside the bytes answers 416; anything else not a
 * single byte range (several ranges, another unit) gets the whole body, as HTTP allows.
 */
export function rangedResponse(request: Request, bytes: Uint8Array, headers: Record<string, string>): Response {
  const size = bytes.byteLength
  const common = { ...headers, 'accept-ranges': 'bytes' }
  const whole = () =>
    new Response(bytes.slice().buffer as ArrayBuffer, { status: 200, headers: { ...common, 'content-length': String(size) } })
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range')?.trim() ?? '')
  if (!m || (m[1] === '' && m[2] === '')) return whole()
  let start: number
  let end: number
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end || (m[1] === '' && Number(m[2]) === 0)) {
    return new Response(null, { status: 416, headers: { ...common, 'content-range': `bytes */${size}` } })
  }
  const part = bytes.slice(start, end + 1)
  return new Response(part.buffer as ArrayBuffer, {
    status: 206,
    headers: { ...common, 'content-length': String(part.byteLength), 'content-range': `bytes ${start}-${end}/${size}` },
  })
}
