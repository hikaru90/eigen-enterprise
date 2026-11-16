import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { movedHref } from '$lib/shell/moved'

/** Setup › Flows is Marketing mail › Flows since 2026-11-16 (the three kinds of mail, Contribute d7080d17): /m/email/flows/** lives at /m/email/marketing/flows/**; old links keep working. */
export const load: PageServerLoad = ({ params, url }) => {
  redirect(308, movedHref('/m/email/marketing/flows', params.rest, url.search))
}
