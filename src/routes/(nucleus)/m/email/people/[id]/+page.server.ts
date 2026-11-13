import type { Actions, PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import {
  contactsAction,
  contactsLoad,
  formContactInput,
  formLogInput,
  liveContactsDeps,
  personActor,
} from '../../../../../../../modules/contacts/http'
import {
  contactHistory,
  contactTags,
  deleteContact,
  getContact,
  logContact,
  setShared,
  updateContact,
} from '../../../../../../../modules/contacts/service'

/**
 * /m/email/people/[id]: one person — who can see them, their history
 * (logged contacts and mail you may read), log a contact, edit,
 * share/unshare and delete. A contact you may not see is a 404.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
  const actor = personActor(locals.user)
  return contactsLoad(async () => {
    const d = await liveContactsDeps()
    const { timeZoneFor, todayFor } = await import('../../../../../../../modules/contacts/live')
    const [contact, tags, today, timeZone] = await Promise.all([
      getContact(d, actor, params.id),
      contactTags(d, actor),
      todayFor(actor.userId),
      timeZoneFor(actor.userId),
    ])
    const { liveContactMail } = await import('../contact-mail.server')
    const history = await contactHistory(d, actor, contact.id, { timeZone, mailWith: liveContactMail })
    return { contact, tags, today, history }
  })
}

export const actions: Actions = {
  save: async ({ locals, params, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return contactsAction(
      'save',
      async () => {
        await updateContact(await liveContactsDeps(), actor, params.id, formContactInput(form))
        return { action: 'save' as const, id: params.id }
      },
      params.id,
    )
  },
  log: async ({ locals, params, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return contactsAction(
      'log',
      async () => {
        await logContact(await liveContactsDeps(), actor, params.id, formLogInput(form))
        return { action: 'log' as const, id: params.id }
      },
      params.id,
    )
  },
  share: async ({ locals, params, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    const value = form.get('shared')
    return contactsAction(
      'share',
      async () => {
        await setShared(await liveContactsDeps(), actor, params.id, value === 'true' ? true : value === 'false' ? false : value)
        return { action: 'share' as const, id: params.id }
      },
      params.id,
    )
  },
  delete: async ({ locals, params }) => {
    const actor = personActor(locals.user)
    return contactsAction(
      'delete',
      async () => {
        await deleteContact(await liveContactsDeps(), actor, params.id)
        redirect(303, '/m/email/people')
      },
      params.id,
    )
  },
}
