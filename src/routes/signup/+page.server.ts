import type { Actions, PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { parseSignupPlanParam } from '$lib/auth/signup-plan'
import { requestCode, verifyCode } from '$lib/server/auth/email-code-actions'
import { managedByEe, unclaimedMessage } from '$lib/server/auth/unclaimed'
import { listEnabledSocialProviderIds } from '$lib/server/auth-social'
import { env } from '$lib/server/env/private-env'
import { companyMail } from '$lib/server/mail'

export const load: PageServerLoad = async (event) => {
  if (event.locals.user) {
    throw redirect(302, '/')
  }

  const unclaimed = await unclaimedMessage()
  // A claimed ee server has no self-signup: people join by invite, and members sign in.
  if (managedByEe() && !unclaimed) {
    throw redirect(302, '/login')
  }

  const rawPlan = event.url.searchParams.get('plan')
  if (rawPlan !== null && parseSignupPlanParam(rawPlan) === null) {
    throw error(400, 'Invalid plan parameter. Use managed or self-hosted.')
  }

  const plan = parseSignupPlanParam(rawPlan)

  return {
    socialProviders: listEnabledSocialProviderIds(env),
    plan,
    emailVerificationRequired: await companyMail().isConfigured(),
    unclaimed,
  }
}

export const actions: Actions = {
  sendCode: (event) => requestCode(event, { requireTerms: true }),
  verifyCode: (event) => verifyCode(event),
}
