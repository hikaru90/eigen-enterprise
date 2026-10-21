import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { countUsers } from '$lib/server/auth/unclaimed'

/**
 * Whether this company can still be claimed (no account exists yet). ee asks
 * this before `ee claim-link` mints a new link (POST /v1/claim): 200 = open,
 * 409 = the company already has an owner. Says nothing else.
 */
export const GET: RequestHandler = async () => {
  if ((await countUsers()) > 0) return json({ open: false }, { status: 409 })
  return json({ open: true })
}
