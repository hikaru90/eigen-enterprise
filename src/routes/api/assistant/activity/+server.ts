import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { loadOwnerLog } from '$lib/server/activity/owner-log'

/** How many events the assistant panel's Activity tab shows; /assistant/activity has the rest. */
const PANEL_EVENTS = 60

/**
 * The assistant panel's Activity tab (polish P-1): the same readable log as
 * /assistant/activity, newest first, for any signed-in member.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 })
  return json(await loadOwnerLog(url.searchParams.get('module'), PANEL_EVENTS))
}
