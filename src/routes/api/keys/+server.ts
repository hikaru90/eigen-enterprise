import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { eq, and } from 'drizzle-orm'
import { generateApiKey } from '$lib/server/api-keys/api-key-utils'
import { getDb } from '$lib/server/db'
import { userApiKey } from '$lib/server/db/schema'
import { jsonError } from '$lib/server/http/api-error'

export const POST: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) {
    return jsonError('Unauthorized', 401)
  }

  const body = await event.request.json().catch(() => ({}))
  const mailSend = body.mailSend === undefined ? false : body.mailSend
  if (typeof mailSend !== 'boolean') {
    return jsonError('mailSend must be true or false', 400)
  }
  // "Can send mail" is the owner's consent; a key must never grant it to another key.
  if (mailSend && event.locals.apiKeyAuth) {
    return jsonError('Only the owner (signed in) can create a key that can send mail', 403)
  }
  const name =
    typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : 'default'

  const { raw, prefix, hash } = generateApiKey()

  const db = getDb()
  const [inserted] = await db
    .insert(userApiKey)
    .values({
      userId: user.id,
      name,
      keyPrefix: prefix,
      keyHash: hash,
      mailSend,
    })
    .returning({ id: userApiKey.id })

  return json({ key: raw, prefix, name, id: inserted.id, mailSend }, { status: 201 })
}

export const GET: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) {
    return jsonError('Unauthorized', 401)
  }

  const db = getDb()
  const keys = await db
    .select({
      id: userApiKey.id,
      name: userApiKey.name,
      keyPrefix: userApiKey.keyPrefix,
      isActive: userApiKey.isActive,
      mailSend: userApiKey.mailSend,
      lastUsedAt: userApiKey.lastUsedAt,
      createdAt: userApiKey.createdAt,
    })
    .from(userApiKey)
    .where(and(eq(userApiKey.userId, user.id), eq(userApiKey.isActive, true)))
    .orderBy(userApiKey.createdAt)

  return json({ keys })
}
