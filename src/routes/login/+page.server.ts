import type { Actions, PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { requestCode, verifyCode } from '$lib/server/auth/email-code-actions'
import { managedByEe, unclaimedMessage } from '$lib/server/auth/unclaimed'
import { listEnabledSocialProviderIds } from '$lib/server/auth-social'
import { env } from '$lib/server/env/private-env'
import { companyMail } from '$lib/server/mail'

export const load: PageServerLoad = async (event) => {
  if (event.locals.user) {
    throw redirect(302, '/')
  }
  const oauthError = event.url.searchParams.get('error')
  return {
    socialProviders: listEnabledSocialProviderIds(env),
    oauthError: oauthError?.trim() || null,
    mailConfigured: await companyMail().isConfigured(),
    unclaimed: await unclaimedMessage(),
    // On an ee server people join by invite only: no "Sign up" link.
    signupOpen: !managedByEe(),
  }
}

export const actions: Actions = {
  sendCode: (event) => requestCode(event, { requireTerms: false }),
  verifyCode: (event) => verifyCode(event),
}
