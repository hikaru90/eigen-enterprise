import type { RequestHandler } from './$types'
import { contributeRoute, readJson } from '../../../../../../modules/contribute/http'
import { voteProposal } from '../../../../../../modules/contribute/service'

/** { direction: -1 | 0 | 1 } → { proposal }. */
export const POST: RequestHandler = ({ locals, params, request }) =>
  contributeRoute(locals.user, async (userId, d) => ({
    proposal: await voteProposal(d, userId, params.id, (await readJson(request)).direction),
  }))
