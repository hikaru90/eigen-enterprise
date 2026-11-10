import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { CONTRIBUTE_DEPENDENCY } from '$lib/contribute/board'
import { canManage } from '../../../../modules/contribute/http'
import { listProposals } from '../../../../modules/contribute/service'

/**
 * /contribute: the board of improvements people proposed from the top bar —
 * Requested, In progress, Shipped — with their votes; the owner and admins
 * also move proposals along and leave notes (the agent does the same through
 * the contribute.* tools).
 */
export const load: PageServerLoad = async ({ locals, depends }) => {
  if (!locals.user) throw redirect(302, '/login')
  depends(CONTRIBUTE_DEPENDENCY)
  const { contributeDeps } = await import('../../../../modules/contribute/live')
  const { foundingCompanyName } = await import('$lib/server/overview/sources')
  const [proposals, manage, companyName] = await Promise.all([
    listProposals(await contributeDeps(), locals.user.id),
    canManage(locals.user.id),
    foundingCompanyName(),
  ])
  return { proposals, canManage: manage, companyName }
}
