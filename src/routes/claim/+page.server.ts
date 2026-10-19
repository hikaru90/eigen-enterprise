import type { Actions, PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { count } from 'drizzle-orm'
import { auth } from '$lib/server/auth'
import { getSafeErrorMessage } from '$lib/server/auth-form-errors'
import { claimCompany, claimConfigFromEnv, claimMessage, claimStatus, ClaimError } from '$lib/server/auth/claim'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { env } from '$lib/server/env/private-env'

/** First-run handover: the installer's private link makes its holder the owner (see $lib/server/auth/claim). */

async function countUsers(): Promise<number> {
  const [row] = await authDb.select({ n: count() }).from(user)
  return Number(row?.n ?? 0)
}

const deps = () => ({
  config: claimConfigFromEnv(env),
  countUsers,
  createCode: async (email: string) => auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } }),
  signIn: async (email: string, code: string) => auth.api.signInEmailOTP({ body: { email, otp: code } }),
})

export const load: PageServerLoad = async (event) => {
  const token = event.url.searchParams.get('token') ?? ''
  const status = await claimStatus(token, deps())
  if (status === 'already_claimed' && event.locals.user) throw redirect(302, '/')
  return { token, ok: status === 'ok', message: status === 'ok' ? null : claimMessage(status) }
}

export const actions: Actions = {
  default: async (event) => {
    const form = await event.request.formData()
    const email = form.get('email')?.toString() ?? ''
    const token = form.get('token')?.toString() ?? ''
    try {
      await claimCompany({ email, token }, deps())
    } catch (err) {
      const message = err instanceof ClaimError ? err.message : getSafeErrorMessage(err, 'Claiming failed')
      return fail(400, { email, message })
    }
    // Signed in as the owner: the onboarding takes it from here.
    throw redirect(303, '/')
  },
}
