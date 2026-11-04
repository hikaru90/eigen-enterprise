import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { normalizeProfileNames } from '$lib/profile/profile'
import { getProfile, saveProfileNames } from '$lib/server/profile/service'

/**
 * The signed-in person's profile (P-5). GET: names, picture, complete.
 * PUT { firstName, lastName }: both required; the account name becomes
 * "First Last". The picture has its own route (/api/profile/avatar).
 */

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user || locals.apiKeyAuth) return json({ error: 'You must be signed in.' }, { status: 401 })
  return json({ profile: await getProfile(locals.user.id) })
}

export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user || locals.apiKeyAuth) return json({ error: 'You must be signed in.' }, { status: 401 })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null) return json({ error: 'Request body must be an object.' }, { status: 400 })
  const names = normalizeProfileNames(body as { firstName?: unknown; lastName?: unknown })
  if (!names.ok) return json({ error: names.error }, { status: 400 })
  await saveProfileNames(locals.user.id, names)
  return json({ profile: await getProfile(locals.user.id) })
}
