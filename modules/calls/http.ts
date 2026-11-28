import type { ScheduleInput, StartInput } from './service'
import { CallsError } from './errors'

/**
 * Shared plumbing for /api/calls/*: CallsError → HTTP status (not_found 404,
 * forbidden 403, invalid 400, conflict 409, not_configured 503 — "Calls are
 * not set up on this server", unavailable 503 — e.g. no speech to text for
 * transcripts). The routes' wrapper (src/routes/api/calls/calls-route.ts)
 * turns a failure into the one error shape; anything else is a 500.
 */

const STATUS: Record<CallsError['code'], number> = {
  not_found: 404,
  forbidden: 403,
  invalid: 400,
  conflict: 409,
  not_configured: 503,
  unavailable: 503,
}

/** The HTTP status a CallsError answers with. */
export const callsErrorStatus = (err: CallsError): number => STATUS[err.code]

/** POST /api/calls/meetings body → ScheduleInput (shape only; the service validates emails, times, links). */
export function scheduleInputOf(body: Record<string, unknown>): ScheduleInput {
  const { userIds, guests, title, startsAt, durationMinutes, externalUrl, inviteLater, timeZone } = body
  if (inviteLater !== undefined && typeof inviteLater !== 'boolean')
    throw new CallsError('invalid', 'inviteLater must be true or false')
  if (
    userIds !== undefined &&
    (!Array.isArray(userIds) || userIds.some((u) => typeof u !== 'string'))
  ) {
    throw new CallsError('invalid', 'userIds must be a list of ids')
  }
  if (title !== undefined && title !== null && typeof title !== 'string')
    throw new CallsError('invalid', 'title must be text')
  if (startsAt !== undefined && startsAt !== null && typeof startsAt !== 'string')
    throw new CallsError('invalid', 'startsAt is an ISO time or null (now)')
  const start = typeof startsAt === 'string' ? new Date(startsAt) : null
  if (start && Number.isNaN(start.getTime()))
    throw new CallsError('invalid', 'startsAt is not a time')
  if (
    durationMinutes !== undefined &&
    durationMinutes !== null &&
    typeof durationMinutes !== 'number'
  ) {
    throw new CallsError('invalid', 'durationMinutes must be a number')
  }
  if (externalUrl !== undefined && externalUrl !== null && typeof externalUrl !== 'string')
    throw new CallsError('invalid', 'externalUrl must be text')
  return {
    userIds: userIds as string[] | undefined,
    guests,
    title: title ?? null,
    startsAt: start,
    durationMinutes: durationMinutes ?? null,
    externalUrl: externalUrl ?? null,
    inviteLater,
    timeZone,
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown
    if (body && typeof body === 'object' && !Array.isArray(body))
      return body as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new CallsError('invalid', 'expected a JSON object body')
}

/** POST /api/calls body → StartInput (shape only; the service decides the rest). */
export function startInputOf(body: Record<string, unknown>): StartInput {
  const { contextKind, contextId, userIds, title } = body
  if (contextKind !== 'dm' && contextKind !== 'channel' && contextKind !== 'meeting') {
    throw new CallsError('invalid', 'contextKind is dm, channel or meeting')
  }
  if (contextId !== undefined && contextId !== null && typeof contextId !== 'string')
    throw new CallsError('invalid', 'contextId must be a string')
  if (
    userIds !== undefined &&
    (!Array.isArray(userIds) || userIds.some((u) => typeof u !== 'string'))
  ) {
    throw new CallsError('invalid', 'userIds must be a list of ids')
  }
  if (title !== undefined && title !== null && typeof title !== 'string')
    throw new CallsError('invalid', 'title must be text')
  return {
    contextKind,
    contextId: contextId ?? null,
    userIds: userIds as string[] | undefined,
    title: title ?? null,
  }
}

/** `?since=<seq>` of a chat read → the cursor (absent: from the start). */
export function chatSinceOf(url: URL): number | undefined {
  const raw = url.searchParams.get('since')
  if (raw === null || raw === '') return undefined
  const seq = Number(raw)
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(seq))
    throw new CallsError('invalid', 'since is a message seq (a whole number, 0 or more)')
  return seq
}

/** A pasted image's multipart upload (field `file`) → the service's input; the service checks type and size. */
export async function chatImageUploadOf(
  request: Request,
): Promise<{ name: string; mime: string; bytes: Uint8Array }> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    throw new CallsError('invalid', 'expected a multipart upload with the image as `file`')
  }
  const file = form.get('file')
  if (!(file instanceof File)) throw new CallsError('invalid', 'expected the image as `file`')
  return { name: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }
}

/** A chat image's bytes as the browser shows them: its own type, never sniffed, private to the reader. */
export function chatImageResponse(img: { mime: string; bytes: Uint8Array }): Response {
  return new Response(img.bytes as BodyInit, {
    headers: {
      'content-type': img.mime,
      'content-length': String(img.bytes.byteLength),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=3600',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  })
}
