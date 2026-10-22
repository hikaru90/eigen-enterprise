import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { eq, and } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import { userApiKey } from '$lib/server/db/schema'
import { jsonError } from '$lib/server/http/api-error'

export const DELETE: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) {
    return jsonError('Unauthorized', 401)
  }

  const { id } = event.params

  const db = getDb()
  const [existing] = await db
    .select({ id: userApiKey.id })
    .from(userApiKey)
    .where(and(eq(userApiKey.id, id), eq(userApiKey.userId, user.id)))
    .limit(1)

  if (!existing) {
    return jsonError('Not found', 404)
  }

  await db.update(userApiKey).set({ isActive: false }).where(eq(userApiKey.id, id))

  return json({ ok: true })
}

/** Edit a key's scopes: `mailSend` ("Can send mail") and/or `mcp` ("MCP access"). Owner session only. */
export const PATCH: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) {
    return jsonError('Unauthorized', 401)
  }
  if (event.locals.apiKeyAuth) {
    return jsonError('Only the owner (signed in) can change what a key may do', 403)
  }
  const body: unknown = await event.request.json().catch(() => null)
  const patch = parseScopePatch(body)
  if (!patch) {
    return jsonError('Body must be { "mailSend"?: boolean, "mcp"?: boolean } with at least one', 400)
  }

  const { id } = event.params
  const db = getDb()
  const [existing] = await db
    .select({ id: userApiKey.id })
    .from(userApiKey)
    .where(
      and(eq(userApiKey.id, id), eq(userApiKey.userId, user.id), eq(userApiKey.isActive, true)),
    )
    .limit(1)
  if (!existing) {
    return jsonError('Not found', 404)
  }

  await db.update(userApiKey).set(patch).where(eq(userApiKey.id, id))
  return json({ id, ...patch })
}

function parseScopePatch(body: unknown): { mailSend?: boolean; mcp?: boolean } | null {
  if (typeof body !== 'object' || body === null) return null
  const keys = Object.keys(body)
  if (keys.length === 0 || keys.some((k) => k !== 'mailSend' && k !== 'mcp')) return null
  const patch: { mailSend?: boolean; mcp?: boolean } = {}
  for (const k of keys as Array<'mailSend' | 'mcp'>) {
    const v = (body as Record<string, unknown>)[k]
    if (typeof v !== 'boolean') return null
    patch[k] = v
  }
  return patch
}
