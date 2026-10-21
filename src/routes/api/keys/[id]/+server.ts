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

/** Edit a key's scopes. Today one: `mailSend` ("Can send mail"). Owner session only. */
export const PATCH: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) {
    return jsonError('Unauthorized', 401)
  }
  if (event.locals.apiKeyAuth) {
    return jsonError('Only the owner (signed in) can change what a key may do', 403)
  }
  const body: unknown = await event.request.json().catch(() => null)
  if (
    typeof body !== 'object' ||
    body === null ||
    Object.keys(body).length !== 1 ||
    typeof (body as { mailSend?: unknown }).mailSend !== 'boolean'
  ) {
    return jsonError('Body must be { "mailSend": true | false }', 400)
  }
  const mailSend = (body as { mailSend: boolean }).mailSend

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

  await db.update(userApiKey).set({ mailSend }).where(eq(userApiKey.id, id))
  return json({ id, mailSend })
}
