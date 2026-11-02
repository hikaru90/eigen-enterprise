import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'

/**
 * Any URL no other page claims lands here, inside the shell group, so a
 * signed-in visitor sees "Page not found" in the shell (with the way back to
 * Chat) instead of a bare page — removed legacy URLs included.
 */
export const load: PageServerLoad = () => {
  error(404, 'Not Found')
}
