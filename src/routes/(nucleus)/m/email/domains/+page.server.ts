import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'

/**
 * Email › Domains moved into Setup › Account (owner, 2026-11-14): the list and the
 * "Add a domain" form live there. Kept so old links land in the right place; a
 * domain's own DNS page stays at /m/email/domains/<id>.
 */
export const load: PageServerLoad = () => {
  redirect(308, '/m/email/setup#domains')
}
