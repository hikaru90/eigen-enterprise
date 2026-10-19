import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { dev } from '$app/environment'
import { consumeSignInCode } from '$lib/server/e2e/verification-link-store'

/** Dev/e2e only: the last emailed sign-in code for an address, so Playwright can log in without an inbox. */
export const GET: RequestHandler = ({ url }) => {
  if (!dev) {
    return json({ error: 'Sign-in code API only available in dev mode' }, { status: 403 })
  }
  const email = url.searchParams.get('email')?.trim()
  if (!email) {
    error(400, 'email query param is required')
  }
  return json({ code: consumeSignInCode(email) ?? null })
}
