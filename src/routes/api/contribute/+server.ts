import type { RequestHandler } from './$types'
import { canManage, contributeRoute, readJson } from '../../../../modules/contribute/http'
import { listProposals, shareProposal } from '../../../../modules/contribute/service'

/** The board: everything not declined, most wanted first; whether this person manages it. */
export const GET: RequestHandler = ({ locals }) =>
  contributeRoute(locals.user, async (userId, d) => ({
    proposals: await listProposals(d, userId),
    canManage: await canManage(userId),
  }))

/** Share a proposal with the judge's reading: { title, kind, area } → { proposal }. */
export const POST: RequestHandler = ({ locals, request }) =>
  contributeRoute(locals.user, async (userId, d) => {
    const b = await readJson(request)
    return { proposal: await shareProposal(d, userId, { title: b.title, kind: b.kind, area: b.area }) }
  })
