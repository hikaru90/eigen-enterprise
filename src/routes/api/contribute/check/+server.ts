import type { RequestHandler } from './$types'
import { contributeRoute, readJson } from '../../../../../modules/contribute/http'
import { checkProposal } from '../../../../../modules/contribute/service'

/** The judge's reading of a draft: { title } → { kind, area, duplicateOf }. Creates nothing. */
export const POST: RequestHandler = ({ locals, request }) =>
  contributeRoute(locals.user, async (userId, d) => checkProposal(d, userId, (await readJson(request)).title))
