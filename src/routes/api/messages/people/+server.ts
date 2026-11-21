import type { RequestHandler } from './$types'
import { messagesRoute } from '../../../../../modules/messages/http'

/** Pickers: the company's members and (once T1 lands) its groups. */
export const GET: RequestHandler = ({ locals }) =>
  messagesRoute(locals.user, 'Listing people (/api/messages)', async (_userId, d) => ({
    people: await d.directory.listPeople(),
    groups: (await d.access.listGroups()).map((g) => ({ id: g.id, name: g.name })),
  }))
