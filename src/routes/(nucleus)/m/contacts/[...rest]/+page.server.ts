import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { movedHref } from '$lib/shell/moved'

/** Contacts moved into Email (owner, 2026-11-13): /m/contacts/** lives at /m/email/people/**; old links keep working. */
export const load: PageServerLoad = ({ params, url }) => {
  redirect(308, movedHref('/m/email/people', params.rest, url.search))
}
