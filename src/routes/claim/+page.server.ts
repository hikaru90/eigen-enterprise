import type { Actions, PageServerLoad } from './$types'
import { fail, redirect, type RequestEvent } from '@sveltejs/kit'
import { count, eq } from 'drizzle-orm'
import { auth } from '$lib/server/auth'
import { signInHeaders } from '$lib/server/auth/sign-in-headers'
import { getSafeErrorMessage } from '$lib/server/auth-form-errors'
import { claimCompany, claimConfigFromEnv, claimMessage, claimStatus, ClaimError } from '$lib/server/auth/claim'
import { authDb } from '$lib/server/db/auth-db'
import { claimConsumed, user } from '$lib/server/db/auth.schema'
import { env } from '$lib/server/env/private-env'
import { foundingCompanyName } from '$lib/server/overview/sources'

/** First-run handover: the installer's private link makes its holder the owner (see $lib/server/auth/claim). */

async function countUsers(): Promise<number> {
  const [row] = await authDb.select({ n: count() }).from(user)
  return Number(row?.n ?? 0)
}

const deps = (event?: Pick<RequestEvent, 'request' | 'getClientAddress'>) => ({
  config: claimConfigFromEnv(env),
  countUsers,
  isConsumed: async (tokenHash: string) =>
    (await authDb.select({ h: claimConsumed.tokenHash }).from(claimConsumed).where(eq(claimConsumed.tokenHash, tokenHash)).limit(1)).length > 0,
  consume: async (tokenHash: string) =>
    (await authDb.insert(claimConsumed).values({ tokenHash }).onConflictDoNothing().returning({ h: claimConsumed.tokenHash })).length === 1,
  createCode: async (email: string) => auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } }),
  signIn: async (email: string, code: string) => auth.api.signInEmailOTP({ body: { email, otp: code }, ...(event ? { headers: signInHeaders(event) } : {}) }),
})

export const load: PageServerLoad = async (event) => {
  // Step 2, signed in as the new owner: a passkey, the way back in before email is set up.
  if (event.locals.user && event.url.searchParams.get('step') === 'passkey') {
    return { step: 'passkey' as const, token: '', ok: true, message: null, email: event.locals.user.email, companyName: await foundingCompanyName() }
  }
  const token = event.url.searchParams.get('token') ?? ''
  const status = await claimStatus(token, deps())
  if (status === 'already_claimed' && event.locals.user) throw redirect(302, '/')
  return { step: 'claim' as const, token, ok: status === 'ok', message: status === 'ok' ? null : claimMessage(status), email: null, companyName: null }
}

export const actions: Actions = {
  default: async (event) => {
    const form = await event.request.formData()
    const email = form.get('email')?.toString() ?? ''
    const token = form.get('token')?.toString() ?? ''
    try {
      await claimCompany({ email, token }, deps(event))
    } catch (err) {
      const message = err instanceof ClaimError ? err.message : getSafeErrorMessage(err, 'Claiming failed')
      return fail(400, { email, message })
    }
    // Signed in as the owner. Sign-in codes go out by email, which isn't set up yet: a passkey first,
    // so the end of this session doesn't lock the owner out. Then the onboarding takes it from here.
    throw redirect(303, '/claim?step=passkey')
  },
}
