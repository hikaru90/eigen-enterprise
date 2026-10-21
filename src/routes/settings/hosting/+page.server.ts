import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'

/**
 * Hosting moved into the website module (D-W3); the old URL follows it. The
 * github/callback + github/installed endpoints under /settings/hosting keep
 * their addresses — the GitHub App manifest is hard-wired to them.
 */
export const load: PageServerLoad = async () => {
  redirect(307, '/m/website/hosting')
}
