import type { Actions, PageServerLoad } from './$types'
import { fail, redirect, type RequestEvent } from '@sveltejs/kit'
import { asc, eq } from 'drizzle-orm'
import { auth } from '$lib/server/auth'
import { getSafeErrorMessage } from '$lib/server/auth-form-errors'
import { ownerLinkConfigFromEnv, ownerLinkMessage, ownerLinkStatus, OwnerLinkError, signInWithOwnerLink } from '$lib/server/auth/owner-link'
import { signInHeaders } from '$lib/server/auth/sign-in-headers'
import { authDb } from '$lib/server/db/auth-db'
import { claimConsumed, user } from '$lib/server/db/auth.schema'
import { env } from '$lib/server/env/private-env'
import { foundingCompanyName } from '$lib/server/overview/sources'

/** Back in as the owner with the link `ee owner-link` printed (see $lib/server/auth/owner-link). */

async function ownerEmail(): Promise<string | null> {
  const [row] = await authDb.select({ email: user.email }).from(user).where(eq(user.role, 'owner')).orderBy(asc(user.createdAt)).limit(1)
  return row?.email ?? null
}

const deps = (event?: Pick<RequestEvent, 'request' | 'getClientAddress'>) => ({
  config: ownerLinkConfigFromEnv(env),
  ownerEmail,
  isConsumed: async (tokenHash: string) =>
    (await authDb.select({ h: claimConsumed.tokenHash }).from(claimConsumed).where(eq(claimConsumed.tokenHash, tokenHash)).limit(1)).length > 0,
  consume: async (tokenHash: string) =>
    (await authDb.insert(claimConsumed).values({ tokenHash }).onConflictDoNothing().returning({ h: claimConsumed.tokenHash })).length === 1,
  createCode: async (email: string) => auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } }),
  signIn: async (email: string, code: string) => auth.api.signInEmailOTP({ body: { email, otp: code }, ...(event ? { headers: signInHeaders(event) } : {}) }),
})

export const load: PageServerLoad = async (event) => {
  // Signed in again: a passkey now, so the next sign-out doesn't need this link again.
  if (event.locals.user && event.url.searchParams.get('step') === 'passkey') {
    return { step: 'passkey' as const, token: '', ok: true, message: null, email: event.locals.user.email, companyName: await foundingCompanyName() }
  }
  const token = event.url.searchParams.get('token') ?? ''
  const d = deps()
  const status = await ownerLinkStatus(token, d)
  return {
    step: 'link' as const,
    token,
    ok: status === 'ok',
    message: status === 'ok' ? null : ownerLinkMessage(status),
    email: status === 'ok' ? await d.ownerEmail() : null,
    companyName: null,
  }
}

export const actions: Actions = {
  default: async (event) => {
    const form = await event.request.formData()
    const token = form.get('token')?.toString() ?? ''
    try {
      await signInWithOwnerLink(token, deps(event))
    } catch (err) {
      return fail(400, { message: err instanceof OwnerLinkError ? err.message : getSafeErrorMessage(err, 'Signing in failed') })
    }
    throw redirect(303, '/owner-link?step=passkey')
  },
}
