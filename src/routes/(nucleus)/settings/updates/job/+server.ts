import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { SubstrateError, SubstrateUnavailableError } from '$lib/server/ee/client'
import { _requireUpdater, _updatesDeps } from '../+page.server'

/**
 * GET: the last update as ee records it, and what runs now — the Updates
 * page polls this while the installer restarts ee and redeploys this app.
 * While ee or the app is down the page gets Caddy's 502 or this 503 and keeps
 * reconnecting; once the new app answers it is ee's record again.
 */
export const GET: RequestHandler = async ({ locals }) => {
  await _requireUpdater(locals)
  try {
    const { job, installed } = await _updatesDeps.client().upgrade()
    return json({ job, installed })
  } catch (err) {
    if (err instanceof SubstrateUnavailableError) return json({ error: err.message }, { status: 503 })
    if (err instanceof SubstrateError) return json({ error: err.message }, { status: 502 })
    throw err
  }
}
