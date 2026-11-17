import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { parseHiddenTiles } from '$lib/dashboard/tiles'
import { saveHiddenTiles } from '$lib/server/dashboard/hidden-tiles'

/**
 * PUT { hidden: TileId[] }: the dashboard tiles the signed-in person closed
 * (Contribute 06894ad7). The whole list each time; [] shows every tile again.
 */
export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user || locals.apiKeyAuth) return json({ error: 'You must be signed in.' }, { status: 401 })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null) return json({ error: 'Request body must be an object.' }, { status: 400 })
  const parsed = parseHiddenTiles((body as { hidden?: unknown }).hidden)
  if (!parsed.ok) return json({ error: parsed.error }, { status: 400 })
  await saveHiddenTiles(locals.user.id, parsed.hidden)
  return json({ hidden: parsed.hidden })
}
