import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { movedHref } from '$lib/shell/moved'

/** Company mail is Transactional mail since 2026-11-16 (the three kinds of mail, Contribute d7080d17): /m/email/company lives at /m/email/transactional; old links keep working. */
export const load: PageServerLoad = ({ params, url }) => {
  redirect(308, movedHref('/m/email/transactional', params.rest, url.search))
}
