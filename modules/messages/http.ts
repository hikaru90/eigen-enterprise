import { json } from '@sveltejs/kit'
import { MessagesError, type MessagesDeps } from './service'

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
