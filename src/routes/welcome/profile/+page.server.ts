import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { safeNextPath } from '$lib/profile/profile'
import { foundingCompanyName } from '$lib/server/overview/sources'
import { getProfile } from '$lib/server/profile/service'

/**
 * The required profile step (P-5): signed in, full screen, before the app
 * shell. The profile gate sends people here with `next`; once the profile
 * is complete there is nothing to do here — on to `next`.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) throw redirect(302, '/login')
  const next = safeNextPath(url.searchParams.get('next'))
  const profile = await getProfile(locals.user.id)
  if (profile.complete) throw redirect(303, next)
  return {
    next,
    companyName: await foundingCompanyName(),
    profile: {
      firstName: profile.firstName,
      lastName: profile.lastName,
      name: profile.name,
      email: profile.email,
      image: profile.image,
      complete: profile.complete,
    },
  }
}
