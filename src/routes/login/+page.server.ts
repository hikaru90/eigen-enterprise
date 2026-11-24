import type { Actions, PageServerLoad, RequestEvent } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { auth } from '$lib/server/auth'
import { requestCode, verifyCode } from '$lib/server/auth/email-code-actions'
import { publicErrorReport } from '$lib/server/auth/public-error-report'
import { signInHeaders } from '$lib/server/auth/sign-in-headers'
import { managedByEe, unclaimedMessage } from '$lib/server/auth/unclaimed'
import { listEnabledSocialProviderIds } from '$lib/server/auth-social'
import { activeDemoGuest } from '$lib/server/demo/guest-access-db'
import { env } from '$lib/server/env/private-env'
import { companyMail } from '$lib/server/mail'
import { openJoinOn } from '$lib/server/members/open-join-db'
import { foundingCompanyName } from '$lib/server/overview/sources'

/**
 * Serializes the short Better Auth internal OTP mint+verify pair for the shared
 * demo teammate so two concurrent clicks on "Explore" never overwrite each
 * other's verification token.
 */
let demoSignInQueue: Promise<unknown> = Promise.resolve()

async function signInAsDemoGuest(
  email: string,
  event: Pick<RequestEvent, 'request' | 'getClientAddress'>,
): Promise<void> {
  const run = async () => {
    const code = await auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } })
    await auth.api.signInEmailOTP({
      body: { email, otp: code },
      headers: signInHeaders(event),
    })
  }
  const next = demoSignInQueue.then(run, run)
  demoSignInQueue = next.catch(() => {})
  await next
}

export const load: PageServerLoad = async (event) => {
  if (event.locals.user) {
    throw redirect(302, '/')
  }
  const oauthError = event.url.searchParams.get('error')
  const unclaimed = await unclaimedMessage()
  const guest = unclaimed ? null : await activeDemoGuest()
  const demoGuest = guest
    ? {
        companyName: (await foundingCompanyName()) ?? 'Demo company',
        guestName: guest.name,
        aiCallsPerIp: guest.aiCallsPerIp,
      }
    : null
  return {
    socialProviders: listEnabledSocialProviderIds(env),
    oauthError: oauthError?.trim() || null,
    mailConfigured: await companyMail().isConfigured(),
    unclaimed,
    demoGuest,
    teamSignIn: event.url.searchParams.get('team') === '1',
    // On an ee server people join by invite: no "Sign up" link…
    signupOpen: !managedByEe(),
    // …unless the company is open to join (members.open_join): then "Join" (/signup).
    openJoin: !demoGuest && managedByEe() && !unclaimed && (await openJoinOn()),
  }
}

export const actions: Actions = {
  sendCode: (event) => requestCode(event, { requireTerms: false }),
  verifyCode: (event) => verifyCode(event),
  enterDemo: async (event) => {
    const guest = await activeDemoGuest()
    if (!guest) {
      return fail(403, { demoError: 'Login-free demo access is not enabled on this company.' })
    }
    try {
      await signInAsDemoGuest(guest.email, event)
    } catch (err) {
      console.error('[login] enterDemo sign-in failed', err)
      const message = 'Could not open the demo right now. Please try again.'
      const { agent } = publicErrorReport(message, {
        attempted: 'Opening the login-free demo company (/login?/enterDemo)',
        err,
        nextSteps: [
          'Check Better Auth signInEmailOTP and the configured demo_guest_access member in the server journal.',
        ],
      })
      return fail(500, { demoError: message, agent })
    }
    throw redirect(303, '/')
  },
}
