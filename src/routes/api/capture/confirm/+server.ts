import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { confirmCapturePreview } from '$lib/server/capture/capture-confirmation'

export const POST: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) error(401, 'Unauthorized')

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    error(400, 'Invalid JSON')
  }

  const thoughtId =
    typeof body === 'object' && body && 'thoughtId' in body
      ? String((body as { thoughtId?: unknown }).thoughtId ?? '').trim()
      : ''
  if (!thoughtId) error(400, 'thoughtId is required')

  const verbatim =
    typeof body === 'object' && body && 'verbatim' in body
      ? Boolean((body as { verbatim?: unknown }).verbatim)
      : false

  try {
    const result = await confirmCapturePreview(user.id, thoughtId, { verbatim })
    return json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to confirm capture'
    console.error('capture confirm failed', { userId: user.id, thoughtId, message })
    if (message.includes('not found')) error(404, message)
    if (message.includes('not awaiting')) error(409, message)
    return json({ error: message }, { status: 500 })
  }
}
