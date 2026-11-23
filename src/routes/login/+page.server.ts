import type { Actions, PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { requestCode, verifyCode } from '$lib/server/auth/email-code-actions'
import { managedByEe, unclaimedMessage } from '$lib/server/auth/unclaimed'
import { listEnabledSocialProviderIds } from '$lib/server/auth-social'
import { env } from '$lib/server/env/private-env'
import { companyMail } from '$lib/server/mail'
import { openJoinOn } from '$lib/server/members/open-join-db'

export const load: PageServerLoad = async (event) => {
  if (event.locals.user) {
    throw redirect(302, '/')
  }
  const oauthError = event.url.searchParams.get('error')
  const unclaimed = await unclaimedMessage()
  return {
    socialProviders: listEnabledSocialProviderIds(env),
    oauthError: oauthError?.trim() || null,
    mailConfigured: await companyMail().isConfigured(),
    unclaimed,
    // On an ee server people join by invite: no "Sign up" link…
    signupOpen: !managedByEe(),
    // …unless the company is open to join (members.open_join): then "Join" (/signup).
    openJoin: managedByEe() && !unclaimed && (await openJoinOn()),
  }
}

export const actions: Actions = {
  sendCode: (event) => requestCode(event, { requireTerms: false }),
  verifyCode: (event) => verifyCode(event),
}
