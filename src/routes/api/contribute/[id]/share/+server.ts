import type { RequestHandler } from './$types'
import { canManage, contributeRoute } from '../../../../../../modules/contribute/http'

/**
 * Sharing of one proposal with the central board (owner/admins):
 * GET → "Show what was sent" { sharing, payload, isOnHub, sentAt };
 * DELETE → "Don't share" { sharing } (withdrawn from the hub if it was sent).
 */

const shareDeps = async () => (await import('../../../../../../modules/contribute/share/live')).shareDeps()

export const GET: RequestHandler = ({ locals, params }) =>
  contributeRoute(locals.user, async (userId) => {
    const { sentPayload } = await import('../../../../../../modules/contribute/share/service')
    return sentPayload(await shareDeps(), { id: userId, canManage: await canManage(userId) }, params.id)
  })

export const DELETE: RequestHandler = ({ locals, params }) =>
  contributeRoute(locals.user, async (userId) => {
    const { dontShare } = await import('../../../../../../modules/contribute/share/service')
    return { sharing: await dontShare(await shareDeps(), { id: userId, canManage: await canManage(userId) }, params.id) }
  })
