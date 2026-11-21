import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { normalizeProfileNames } from '$lib/profile/profile'
import { getProfile, saveProfileNames } from '$lib/server/profile/service'
import { refusalReport } from '$lib/server/errors/report'

const PUT_ATTEMPT = 'Saving your first and last name (PUT /api/profile)'

/** A refused save: the sentence for the person + the agent half (input = the names sent). */
function refuse(sentence: string, status: number, input?: unknown) {
  return json(
    refusalReport(sentence, {
      attempted: PUT_ATTEMPT,
      ...(input !== undefined ? { input } : {}),
      nextSteps: [
        'PUT /api/profile (src/routes/api/profile/+server.ts) refused the request before saving; the sentence says why (normalizeProfileNames in src/lib/profile/profile.ts checks the names).',
      ],
    }),
    { status },
  )
}

/**
 * The signed-in person's profile (P-5). GET: names, picture, complete.
 * PUT { firstName, lastName }: both required; the account name becomes
 * "First Last". The picture has its own route (/api/profile/avatar).
 */

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user || locals.apiKeyAuth)
    return json({ error: 'You must be signed in.' }, { status: 401 })
  return json({ profile: await getProfile(locals.user.id) })
}

export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user || locals.apiKeyAuth) return refuse('You must be signed in.', 401)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return refuse('Request body must be JSON.', 400)
  }
  if (typeof body !== 'object' || body === null)
    return refuse('Request body must be an object.', 400)
  const names = normalizeProfileNames(body as { firstName?: unknown; lastName?: unknown })
  if (!names.ok) return refuse(names.error, 400, body)
  await saveProfileNames(locals.user.id, names)
  return json({ profile: await getProfile(locals.user.id) })
}
