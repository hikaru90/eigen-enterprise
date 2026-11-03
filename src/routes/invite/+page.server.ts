import type { Actions, PageServerLoad } from './$types'
import { fail, redirect, type RequestEvent } from '@sveltejs/kit'
import { auth } from '$lib/server/auth'
import { signInHeaders } from '$lib/server/auth/sign-in-headers'
import { getSafeErrorMessage } from '$lib/server/auth-form-errors'
import { InviteError, joinWithInvite, type AcceptDeps } from '$lib/server/members/accept'
import { dbMemberStore } from '$lib/server/members/db-store'
import { inviteMessage, inviteStatus } from '$lib/server/members/service'
import { foundingCompanyName } from '$lib/server/overview/sources'

/**
 * Accept a member invite (owner decision W-4): the link is the proof. Joining
 * creates the account with the invited role and signs in; the next step
 * (/invite?step=passkey, signed in) registers a passkey — the way back in, no
 * email needed. It stays on this public route on purpose: the shell is not
 * the place for a one-time welcome step.
 */

const deps = (event: Pick<RequestEvent, 'request' | 'getClientAddress'>): AcceptDeps => ({
  store: dbMemberStore,
  createCode: async (email) => auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } }),
  signIn: (email, code, name) => auth.api.signInEmailOTP({ body: { email, otp: code, name }, headers: signInHeaders(event) }),
})

export const load: PageServerLoad = async (event) => {
  const companyName = await foundingCompanyName()
  if (event.locals.user) {
    if (event.url.searchParams.get('step') === 'passkey') {
      return { step: 'passkey' as const, token: '', ok: true as const, message: null, companyName, email: event.locals.user.email, role: null }
    }
    throw redirect(302, '/')
  }
  const token = event.url.searchParams.get('token') ?? ''
  const st = await inviteStatus(token, { store: dbMemberStore })
  if (!st.ok) return { step: 'join' as const, token, ok: false as const, message: inviteMessage(st.reason), companyName, email: null, role: null }
  return { step: 'join' as const, token, ok: true as const, message: null, companyName, email: st.invite.email, role: st.invite.role }
}

export const actions: Actions = {
  join: async (event) => {
    const form = await event.request.formData()
    const token = form.get('token')?.toString() ?? ''
    const name = form.get('name')?.toString() ?? ''
    try {
      await joinWithInvite(token, { name }, deps(event))
    } catch (err) {
      const message = err instanceof InviteError ? err.message : getSafeErrorMessage(err, 'Joining did not work')
      return fail(400, { name, message })
    }
    throw redirect(303, '/invite?step=passkey')
  },
}
