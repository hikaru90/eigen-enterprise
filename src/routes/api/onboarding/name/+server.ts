import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { setWelcomeDisplayName } from '$lib/server/onboarding/welcome'

/**
 * Persists the name given during the boot sequence ("What should I call you?").
 * Body: { name: string } — trimmed, max 80 chars. Fail loud: validation errors
 * return 400 with the exact reason, never a fake ok.
 */
export const POST: RequestHandler = async (event) => {
  if (!event.locals.user) {
    return json({ error: 'You must be signed in.' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    return json({ error: 'Request body must be JSON.' }, { status: 400 })
  }

  const name =
    typeof body === 'object' && body !== null && 'name' in body
      ? String((body as { name: unknown }).name ?? '').trim()
      : ''

  if (!name) {
    return json({ error: 'Name must not be empty.' }, { status: 400 })
  }
  if (name.length > 80) {
    return json({ error: 'Name must be 80 characters or fewer.' }, { status: 400 })
  }

  await setWelcomeDisplayName(event.locals.user.id, name)

  return json({ ok: true, name })
}
