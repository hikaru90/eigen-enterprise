import type { AppListResult } from '../../../../../../modules/website/apps/tools'
import type { PageServerLoad } from './$types'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { ownerRun } from '$lib/server/website/owner-run'

/**
 * /m/website/apps: the Apps overview — the company site, every app with its
 * domains and newest deploy, and the entries behind the "+" card. ee being
 * unreachable is a state the page shows explicitly (managed:false), not an
 * error; anything else fails loud.
 */
export const load: PageServerLoad = async (event) => {
  const user = await requireAdmin(event.locals.user)
  return ownerRun<AppListResult>(user, 'website.app_list', {})
}
