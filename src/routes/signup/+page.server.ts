import type { Actions, PageServerLoad, RequestEvent } from './$types'
import { error, fail, redirect } from '@sveltejs/kit'
import { parseSignupPlanParam } from '$lib/auth/signup-plan'
import { requestCode, verifyCode } from '$lib/server/auth/email-code-actions'
import { managedByEe, unclaimedMessage } from '$lib/server/auth/unclaimed'
import { listEnabledSocialProviderIds } from '$lib/server/auth-social'
import { activeDemoGuest } from '$lib/server/demo/guest-access-db'
import { env } from '$lib/server/env/private-env'
import { companyMail } from '$lib/server/mail'
import { openJoinOffMessage } from '$lib/server/members/open-join'
import { openJoinOn } from '$lib/server/members/open-join-db'
import { foundingCompanyName } from '$lib/server/overview/sources'

/**
 * /signup. Outside ee (dev, tests): open signup, the first account is the owner.
 * On an unclaimed ee server: the claim message. On a claimed ee server it is
 * the open-join page when the company switched open join on
 * (members.open_join): the normal email code, plus a name, joins as a member.
 * With open join off there is no self-signup: the page goes to /login and the
 * actions refuse plainly.
 */
type Mode = 'open' | 'unclaimed' | 'join' | 'closed'

async function signupMode(): Promise<Mode> {
  if (!managedByEe()) return 'open'
  if (await unclaimedMessage()) return 'unclaimed'
  return (await openJoinOn()) ? 'join' : 'closed'
}

async function closed() {
  return fail(403, { step: 'email' as const, email: '', message: openJoinOffMessage(await foundingCompanyName()) })
}

export const load: PageServerLoad = async (event) => {
  if (event.locals.user) {
    throw redirect(302, '/')
  }
  if (await activeDemoGuest()) {
    throw redirect(302, '/login')
  }

  const mode = await signupMode()
  if (mode === 'closed') {
    throw redirect(302, '/login')
  }
  const unclaimed = mode === 'unclaimed' ? await unclaimedMessage() : null

  const rawPlan = event.url.searchParams.get('plan')
  if (rawPlan !== null && parseSignupPlanParam(rawPlan) === null) {
    throw error(400, 'Invalid plan parameter. Use managed or self-hosted.')
  }

  const plan = parseSignupPlanParam(rawPlan)

  return {
    // Open join is the email code only: a social sign-up would make an account outside it.
    socialProviders: mode === 'join' ? [] : listEnabledSocialProviderIds(env),
    plan,
    emailVerificationRequired: await companyMail().isConfigured(),
    unclaimed,
    openJoin: mode === 'join',
    companyName: mode === 'join' ? await foundingCompanyName() : null,
  }
}

export const actions: Actions = {
  sendCode: async (event: RequestEvent) => {
    const mode = await signupMode()
    if (mode === 'closed') return closed()
    return mode === 'join' ? requestCode(event, { requireTerms: true, openJoin: true }) : requestCode(event, { requireTerms: true })
  },
  verifyCode: async (event: RequestEvent) => {
    const mode = await signupMode()
    if (mode === 'closed') return closed()
    return mode === 'join' ? verifyCode(event, { openJoin: true }) : verifyCode(event)
  },
}
