import type { Actions, PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import {
  contactsAction,
  contactsLoad,
  formContactInput,
  formShared,
  liveContactsDeps,
  personActor,
} from '../../../../../../../modules/contacts/http'
import { contactTags, createContact, visibilityDefaults } from '../../../../../../../modules/contacts/service'

/** /m/email/people/new: add a person — who sees it starts at your default for new contacts (Contacts settings). */
export const load: PageServerLoad = async ({ locals }) => {
  const actor = personActor(locals.user)
  return contactsLoad(async () => {
    const d = await liveContactsDeps()
    const [tags, defaults] = await Promise.all([contactTags(d, actor), visibilityDefaults(d, actor)])
    return { tags, visibility: defaults.effective }
  })
}

export const actions: Actions = {
  default: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return contactsAction('create', async () => {
      const shared = formShared(form)
      const contact = await createContact(await liveContactsDeps(), actor, formContactInput(form), shared === undefined ? {} : { shared })
      redirect(303, `/m/email/people/${contact.id}`)
    })
  },
}
