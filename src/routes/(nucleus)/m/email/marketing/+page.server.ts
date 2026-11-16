import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'

/** /m/email/marketing opens its first section, the lists; the query carries over. */
export const load: PageServerLoad = ({ url }) => {
  redirect(307, `/m/email/marketing/lists${url.search}`)
}
