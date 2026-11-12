import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { SubstrateError, SubstrateUnavailableError } from '$lib/server/ee/client'
import { _backupsDeps, _requireOwner } from '../+page.server'

/**
 * GET: the last check/restore of a backup as ee records it — the restore
 * screen polls this while ee and the company restart. Owner only. While ee is
 * down it answers 503 (the page keeps reconnecting); once the company is back
 * it is ee's record again.
 */
export const GET: RequestHandler = async ({ locals }) => {
  await _requireOwner(locals)
  try {
    return json(await _backupsDeps.client().restoreJob())
  } catch (err) {
    if (err instanceof SubstrateUnavailableError) return json({ error: err.message }, { status: 503 })
    if (err instanceof SubstrateError) return json({ error: err.message }, { status: 502 })
    throw err
  }
}
