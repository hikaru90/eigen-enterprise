import type { RequestHandler } from './$types'
import { canManage, contributeRoute, readJson } from '../../../../../modules/contribute/http'
import { updateProposal } from '../../../../../modules/contribute/service'

/** Owner/admin: { status?, note? } → { proposal }. */
export const PATCH: RequestHandler = ({ locals, params, request }) =>
  contributeRoute(locals.user, async (userId, d) => {
    const b = await readJson(request)
    const actor = { id: userId, kind: 'human' as const, canManage: await canManage(userId) }
    return { proposal: await updateProposal(d, actor, params.id, { status: b.status, note: b.note }) }
  })
