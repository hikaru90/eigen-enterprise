import type { Actions, PageServerLoad } from './$types'
import { fail, redirect, type RequestEvent } from '@sveltejs/kit'
import { auth } from '$lib/server/auth'
import { signInHeaders } from '$lib/server/auth/sign-in-headers'
import { takeDeliveryFailure } from '$lib/server/auth/deliver-code'
import { getSafeErrorMessage } from '$lib/server/auth-form-errors'
import { acceptInvite, InviteError, sendInviteCode, type AcceptDeps } from '$lib/server/members/accept'
import { dbMemberStore } from '$lib/server/members/db-store'
import { inviteMessage, inviteStatus } from '$lib/server/members/service'
import { foundingCompanyName } from '$lib/server/overview/sources'

/** Accept a member invite: the link's token → a code to the invited address → signed in with the invited role. */

const deps = (event?: Pick<RequestEvent, 'request' | 'getClientAddress'>): AcceptDeps => ({
  store: dbMemberStore,
  sendCode: async (email) => {
    takeDeliveryFailure(email) // clear any stale failure
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
    const failure = takeDeliveryFailure(email)
    if (failure) throw failure
  },
  signIn: (email, code) =>
    auth.api.signInEmailOTP({ body: { email, otp: code }, ...(event ? { headers: signInHeaders(event) } : {}) }),
})

export const load: PageServerLoad = async (event) => {
  if (event.locals.user) throw redirect(302, '/')
  const token = event.url.searchParams.get('token') ?? ''
  const st = await inviteStatus(token, { store: dbMemberStore })
  const companyName = await foundingCompanyName()
  if (!st.ok) return { token, ok: false as const, message: inviteMessage(st.reason), companyName, email: null, role: null }
  return { token, ok: true as const, message: null, companyName, email: st.invite.email, role: st.invite.role }
}

export const actions: Actions = {
  sendCode: async (event) => {
    const form = await event.request.formData()
    const token = form.get('token')?.toString() ?? ''
    try {
      const { email } = await sendInviteCode(token, deps())
      return { step: 'code' as const, email, notice: `We sent a 6-digit code to ${email}.` }
    } catch (err) {
      const message = err instanceof InviteError ? err.message : getSafeErrorMessage(err, 'Could not send the code')
      return fail(err instanceof InviteError ? 400 : 503, { step: 'email' as const, message })
    }
  },
  verifyCode: async (event) => {
    const form = await event.request.formData()
    const token = form.get('token')?.toString() ?? ''
    const code = form.get('code')?.toString().trim() ?? ''
    if (!/^[0-9]{6}$/.test(code)) {
      return fail(400, { step: 'code' as const, email: form.get('email')?.toString() ?? '', message: 'Enter the 6-digit code.' })
    }
    try {
      await acceptInvite(token, code, deps(event))
    } catch (err) {
      const message = err instanceof InviteError ? err.message : getSafeErrorMessage(err, 'That code did not work')
      return fail(400, { step: 'code' as const, email: form.get('email')?.toString() ?? '', message })
    }
    throw redirect(303, '/')
  },
}
