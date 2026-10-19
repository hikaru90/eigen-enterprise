import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'

/** Sign-in is passwordless (an emailed code), so there is no password to reset. Old links land on login. */
export const load: PageServerLoad = () => {
  throw redirect(301, '/login')
}
