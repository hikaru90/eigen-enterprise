import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { movedHref } from '$lib/shell/moved'

/** GitHub repos moved into Drive (owner, 2026-11-13): /m/repos lives at /drive/github; old links keep working. */
export const load: PageServerLoad = ({ params, url }) => {
  redirect(308, movedHref('/drive/github', params.rest, url.search))
}
