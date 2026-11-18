import type { Actions, PageServerLoad } from './$types'
import { contactsAction, contactsLoad, liveContactsDeps, personActor } from '../../../../../../../modules/contacts/http'
import { contactSettings, setCompanyDefaultVisibility, setMyDefaultVisibility } from '../../../../../../../modules/contacts/service'

/**
 * /m/email/people/settings (Contribute 9d28020a): who sees a new contact by
 * default — your own choice (Private, Whole team, or the company's), and for
 * the owner and admins the company-wide default. Yours wins over the company's;
 * with neither set, new contacts are private. Applies to contacts added by
 * hand, by import and by the agent.
 */
export const load: PageServerLoad = async ({ locals }) => {
  const actor = personActor(locals.user)
  return contactsLoad(async () => contactSettings(await liveContactsDeps(), actor))
}

const field = (form: FormData) => {
  const v = form.get('visibility')
  return typeof v === 'string' ? v : null
}

export const actions: Actions = {
  mine: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return contactsAction('mine', async () => {
      await setMyDefaultVisibility(await liveContactsDeps(), actor, field(form))
      return { action: 'mine' as const, saved: true }
    })
  },
  company: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return contactsAction('company', async () => {
      await setCompanyDefaultVisibility(await liveContactsDeps(), actor, field(form))
      return { action: 'company' as const, saved: true }
    })
  },
}
