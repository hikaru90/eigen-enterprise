import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { movedHref } from '$lib/shell/moved'

/** The Lists tab is Marketing mail › Lists since 2026-11-16 (the three kinds of mail, Contribute d7080d17): /m/email/contacts/** lives at /m/email/marketing/lists/**; old links keep working. */
export const load: PageServerLoad = ({ params, url }) => {
  redirect(308, movedHref('/m/email/marketing/lists', params.rest, url.search))
}
