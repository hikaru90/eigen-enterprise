import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'

/** Settings → Passkeys: register this machine's authenticator as a way back in. */
export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login')
  // Passkeys are bound to the origin the browser sees — shown on the page so a
  // stale bookmark (a different port or host) is easy to recognize.
  return { origin: event.url.origin }
}
