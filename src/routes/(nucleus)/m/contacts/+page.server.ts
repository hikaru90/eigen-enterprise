import type { Actions, PageServerLoad } from './$types'
import {
  contactsAction,
  contactsLoad,
  formLogInput,
  liveContactsDeps,
  personActor,
} from '../../../../../modules/contacts/http'
import { followUps, listContacts, logContact, normaliseTag } from '../../../../../modules/contacts/service'

/**
 * /m/contacts: the people you know — "Follow up next" (who to write to next:
 * due and coming up, soonest first) and every contact you may see, filtered
 * by one tag and/or a name/organisation search (?tag=, ?q=). Today is the
 * person's own day (their preferred timezone).
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  const actor = personActor(locals.user)
  const rawTag = url.searchParams.get('tag') ?? ''
  const q = url.searchParams.get('q') ?? ''
  return contactsLoad(async () => {
    // The tag as stored (so the chip for it shows as current); a malformed one is a 400.
    const filter = { tag: rawTag.trim() === '' ? '' : normaliseTag(rawTag), q }
    const d = await liveContactsDeps()
    const { todayFor } = await import('../../../../../modules/contacts/live')
    const today = await todayFor(actor.userId)
    const [list, due] = await Promise.all([
      listContacts(d, actor, { tag: filter.tag, query: filter.q }),
      followUps(d, actor, today),
    ])
    return { contacts: list.contacts, tags: list.tags, followUps: due, today, filter }
  })
}

export const actions: Actions = {
  /** "Log contact" on a follow-up row. */
  log: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    const id = typeof form.get('id') === 'string' ? (form.get('id') as string) : ''
    return contactsAction(
      'log',
      async () => {
        await logContact(await liveContactsDeps(), actor, id, formLogInput(form))
        return { action: 'log' as const, id }
      },
      id,
    )
  },
}
