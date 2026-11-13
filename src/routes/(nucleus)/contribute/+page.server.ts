import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { CONTRIBUTE_DEPENDENCY } from '$lib/contribute/board'
import { canManage } from '../../../../modules/contribute/http'
import { listProposals } from '../../../../modules/contribute/service'
import { sharingStates, type ShareItemView } from '../../../../modules/contribute/share/service'

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
  // The owner and admins see each proposal's sharing with the central board.
  let sharing: Record<string, ShareItemView> | null = null
  if (manage) {
    const { shareDeps } = await import('../../../../modules/contribute/share/live')
    sharing = await sharingStates(await shareDeps(), proposals.map((p) => p.id))
  }
  return { proposals, canManage: manage, companyName, sharing }
}
