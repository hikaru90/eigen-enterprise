import type { Actions, PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import {
  contactsAction,
  contactsLoad,
  formContactInput,
  liveContactsDeps,
  personActor,
} from '../../../../../../modules/contacts/http'
import { contactTags, createContact } from '../../../../../../modules/contacts/service'

/** /m/contacts/new: add a person — private to you unless you share it with the company right away. */
export const load: PageServerLoad = async ({ locals }) => {
  const actor = personActor(locals.user)
  return contactsLoad(async () => ({ tags: await contactTags(await liveContactsDeps(), actor) }))
}

export const actions: Actions = {
  default: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return contactsAction('create', async () => {
      const contact = await createContact(await liveContactsDeps(), actor, formContactInput(form), {
        shared: form.get('shared') === 'on',
      })
      redirect(303, `/m/contacts/${contact.id}`)
    })
  },
}
