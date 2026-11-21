import type { Actions, PageServerLoad } from './$types'
import {
  contactsAction,
  contactsLoad,
  formLogInput,
  liveContactsDeps,
  personActor,
} from '../../../../../../modules/contacts/http'
import {
  listContacts,
  logContact,
  normaliseTag,
  shareChoices,
} from '../../../../../../modules/contacts/service'

/**
 * /m/email/people: the people you know — every contact you may see, filtered
 * by one tag and/or a name/organisation search (?tag=, ?q=). "Next up" (who to
 * write to next) is the assistant's pick, fetched by the page from
 * /api/contacts/next-up; it replaced the date-only "Follow up next" list
 * (Contribute 12626c2f / 057ebd74). Today is the person's own day (their
 * preferred timezone). `choices` = the people and groups to share the
 * selected contacts with (Contribute 9d28020a; /api/contacts/sharing applies it).
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  const actor = personActor(locals.user)
  const rawTag = url.searchParams.get('tag') ?? ''
  const q = url.searchParams.get('q') ?? ''
  return contactsLoad(async () => {
    // The tag as stored (so the chip for it shows as current); a malformed one is a 400.
    const filter = { tag: rawTag.trim() === '' ? '' : normaliseTag(rawTag), q }
    const d = await liveContactsDeps()
    const { todayFor } = await import('../../../../../../modules/contacts/live')
    const [list, today, choices] = await Promise.all([
      listContacts(d, actor, { tag: filter.tag, query: filter.q }),
      todayFor(actor.userId),
      shareChoices(d, actor),
    ])
    return { contacts: list.contacts, tags: list.tags, today, filter, choices }
  })
}

export const actions: Actions = {
  /** "Log contact" on a Next up suggestion (with where they are now). */
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
