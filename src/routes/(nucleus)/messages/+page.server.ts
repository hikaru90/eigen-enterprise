import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { listConversations } from '../../../../modules/messages/service'

/**
 * /messages (phase-workspace C1): the person's channels and DMs with unread
 * counts, the pickers' people and groups, and the event id the page loaded
 * at — the live stream resumes from it so nothing committed in between is lost.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, '/login')
  const { messagesDeps } = await import('../../../../modules/messages/live')
  const d = await messagesDeps()
  const cursor = await d.store.latestEventId()
  const [conversations, people, groups] = await Promise.all([
    listConversations(d, locals.user.id),
    d.directory.listPeople(),
    d.access.listGroups(),
  ])
  return {
    me: locals.user.id,
    cursor,
    conversations,
    people,
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
  }
}
