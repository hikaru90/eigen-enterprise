import type { Actions, PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { requestCode, verifyCode } from '$lib/server/auth/email-code-actions'
import { listEnabledSocialProviderIds } from '$lib/server/auth-social'
import { env } from '$lib/server/env/private-env'
import { isOwleryMailConfigured } from '$lib/server/owlery/mail'

export const load: PageServerLoad = (event) => {
  if (event.locals.user) {
    throw redirect(302, '/')
  }
  const oauthError = event.url.searchParams.get('error')
  return {
    socialProviders: listEnabledSocialProviderIds(env),
    oauthError: oauthError?.trim() || null,
    mailConfigured: isOwleryMailConfigured(env),
  }
}

export const actions: Actions = {
  sendCode: (event) => requestCode(event, { requireTerms: false }),
  verifyCode: (event) => verifyCode(event),
}
