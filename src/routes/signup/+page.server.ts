import type { Actions, PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { parseSignupPlanParam } from '$lib/auth/signup-plan'
import { requestCode, verifyCode } from '$lib/server/auth/email-code-actions'
import { listEnabledSocialProviderIds } from '$lib/server/auth-social'
import { env } from '$lib/server/env/private-env'
import { companyMail } from '$lib/server/mail'

export const load: PageServerLoad = async (event) => {
  if (event.locals.user) {
    throw redirect(302, '/')
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
  }
}

export const actions: Actions = {
  sendCode: (event) => requestCode(event, { requireTerms: true }),
  verifyCode: (event) => verifyCode(event),
}
